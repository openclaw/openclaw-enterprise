# Local Kubernetes and development operations

Build digest-pinned local Kubernetes images, verify development TUI access, or
stop the development stack. Run commands from the repository root. Use the
[production deployment sequence](../deploy.md#production) for Namespace and Agent setup.

## Build images for local Kubernetes

This uses the same build/import path as the local Kubernetes tests. Build the
controller from this checkout and one combined OpenClaw/Codex image for both
Installation image slots. Local build digests vary by build and platform, so
read them from the imported images instead of copying a sample digest.

Prerequisites: Docker, k3d, and [yq v4](https://github.com/mikefarah/yq).
Create a disposable single-server cluster without changing your kubeconfig:

```bash
export CLUSTER="occ-images-$(date +%s)"
export OCC_EXAMPLE_DIRECTORY="$(mktemp -d)"
k3d cluster create "$CLUSTER" --servers 1 --agents 0 \
  --api-port 127.0.0.1:0 \
  --kubeconfig-update-default=false --kubeconfig-switch-context=false
k3d kubeconfig get "$CLUSTER" > "$OCC_EXAMPLE_DIRECTORY/kubeconfig"
chmod 600 "$OCC_EXAMPLE_DIRECTORY/kubeconfig"
export KUBECONFIG_FILE="$OCC_EXAMPLE_DIRECTORY/kubeconfig"
export CONTEXT="k3d-$CLUSTER"
```

Build and import the images:

```bash
docker build --target runtime \
  --build-arg NODE_BASE_IMAGE=docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584 \
  -t "localhost/$CLUSTER/controller:local" .
docker build -f deploy/runtime/Dockerfile \
  -t "localhost/$CLUSTER/runtime:local" deploy/runtime
k3d image import "localhost/$CLUSTER/controller:local" \
  "localhost/$CLUSTER/runtime:local" -c "$CLUSTER"
```

Register each imported manifest digest in k3s:

```bash
for role in controller runtime; do
  tag="localhost/$CLUSTER/$role:local"
  digest="$(docker exec "k3d-$CLUSTER-server-0" ctr -n k8s.io images list |
    awk -v image="$tag" '$1 == image { print $3 }')"
  printf '%s\n' "$digest" | grep -Eq '^sha256:[a-f0-9]{64}$' || exit 1
  reference="localhost/$CLUSTER/$role@$digest"
  docker exec "k3d-$CLUSTER-server-0" ctr -n k8s.io images tag "$tag" "$reference"
  if [ "$role" = controller ]; then
    export CONTROLLER_IMAGE="$reference"
  else
    export RUNTIME_IMAGE="$reference"
  fi
done
```

Populate private YAML copies with those references:

```bash
umask 077
cp deploy/examples/production/{values,installation,bootstrap-pvc}.yaml "$OCC_EXAMPLE_DIRECTORY/"
yq -i '.images.controller = strenv(CONTROLLER_IMAGE)' "$OCC_EXAMPLE_DIRECTORY/values.yaml"
yq -i '.drivers.compute.configuration.images.gateway = strenv(RUNTIME_IMAGE) |
  .drivers.compute.configuration.images.agent = strenv(RUNTIME_IMAGE)' "$OCC_EXAMPLE_DIRECTORY/installation.yaml"
printf 'Image-configured examples: %s\n' "$OCC_EXAMPLE_DIRECTORY"
```

These references work in this cluster and retain `requireImmutableDigest: true`.
Use the generated directory in place of `/secure/occ` in the production commands;
keep its image values and kubeconfig instead of copying the templates again.
Set the remaining database, HTTPS, network, and storage inputs for your trial
(k3d's default StorageClass is `local-path`). The images alone do not configure
those dependencies or prove an Agent model turn. When finished with the trial,
run `KUBECONFIG="$KUBECONFIG_FILE" k3d cluster delete "$CLUSTER"`.

## Stop development safely

Run the exact command under `Cleanup` in the `dev-up` output. The Podman form
includes its detected API socket and `compose.podman.yaml`; the Docker form
remains `docker compose down` plus any forwarded global options.

This preserves PostgreSQL, Configuration, and bootstrap-key volumes. Add
`--volumes` only when deliberately deleting the local
Installation after accounting for Agent containers and tenant networks owned by
Docker Compute.

## Development end-to-end TUI

Prerequisites: completed [development startup](../deploy.md#development) with
Docker selected, exported `OCC_URL` and `OCC_SERVICE_KEY_FILE` from the `dev-up` output,
`OPENAI_API_KEY` available to the worker, and the quickstart runtime image.

Recreate the worker when it was already running without the model credential:

```bash
docker compose up -d --force-recreate worker
docker compose exec -T worker \
  node -e 'process.exit((process.env.OPENAI_API_KEY || "").trim() ? 0 : 1)'
```

Select the initial `default` Namespace and save its server-generated ID:

```bash
NAMESPACE_ID="$(./bin/occ namespace list --output json | python3 -c 'import json,sys; matches=[n for n in json.load(sys.stdin) if n["name"] == "default"]; assert len(matches) == 1, "Expected one bootstrap-created default Namespace"; print(matches[0]["id"])')"
export NAMESPACE_ID OCC_NAMESPACE="$NAMESPACE_ID"
```

Poll `./bin/occ namespace get "$NAMESPACE_ID"` until `STATUS` is
`ready`. Create `configuration.json` from the embedded OpenClaw example in
[Configure the Agent runtime](production-agents.md#configure-the-agent-runtime), then create and
deploy the Agent:

```bash
CONFIGURATION_RESPONSE="$(./bin/occ configuration create --file configuration.json --output json)"
CONFIGURATION_ID="$(printf '%s' "$CONFIGURATION_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
printf '{"name":"tui-agent","configurationId":"%s","executionMode":"embedded"}\n' "$CONFIGURATION_ID" > agent.json
AGENT_RESPONSE="$(./bin/occ agent create --file agent.json --output json)"
AGENT_ID="$(printf '%s' "$AGENT_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
REVISION_RESPONSE="$(./bin/occ agent deploy "$AGENT_ID" --output json)"
REVISION_ID="$(printf '%s' "$REVISION_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
export AGENT_ID REVISION_ID
```

After `occ namespace get "$NAMESPACE_ID"` reports `ready` and
`occ agent get "$AGENT_ID"` reports the deployed
`activeRevisionId`, discover the single owned Docker gateway container:

```bash
GATEWAY_CONTAINER="$(docker ps -q \
  --filter label=org.openclaw.enterprise.managed=true \
  --filter label=org.openclaw.enterprise.compute-driver=docker \
  --filter label=org.openclaw.enterprise.namespace-id="$NAMESPACE_ID" \
  --filter label=org.openclaw.enterprise.agent-id="$AGENT_ID" \
  --filter label=org.openclaw.enterprise.revision-id="$REVISION_ID" \
  --filter label=org.openclaw.enterprise.role=gateway)"
test "$(printf '%s\n' "$GATEWAY_CONTAINER" | sed '/^$/d' | wc -l)" -eq 1
export GATEWAY_CONTAINER
```

Attach the TUI inside that container. It already has the gateway URL and token:

```bash
E2E_SESSION="occ-tui-$(date +%Y%m%d%H%M%S)"
NONCE="$(python3 -c 'import secrets; print("OCC_TUI_" + secrets.token_hex(8))')"
docker exec -it -e OPENCLAW_STATE_DIR=/tmp/occ-tui-client \
  "$GATEWAY_CONTAINER" node /app/openclaw.mjs tui \
  --session "$E2E_SESSION" --message "Reply exactly: $NONCE"
```

Verify the assistant replies with the nonce, send a second nonce in the same
TUI, then press Ctrl+D. Exiting the TUI does not stop the Agent gateway. Do not
pass OCC service keys, gateway tokens, `--url`, or `--token` on the command
line.

To stop the Agent without deleting its revision or workspace, submit the
bodyless operation and poll until the active pointer is absent:

```bash
./bin/occ agent stop "$AGENT_ID"
./bin/occ agent get "$AGENT_ID"
```

The stop result reports `DESIRED STATE` as `stopped`. The later read must retain
the Agent and report no `ACTIVE REVISION`; the worker also
removes its Docker runtime containers. Repeating the stop is safe. Run the
deployment command again to resume with a new immutable revision.
