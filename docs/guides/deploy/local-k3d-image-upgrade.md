# Upgrade images on a persistent local k3d installation

Upgrade an existing Helm-installed OpenClaw Control Plane (OCC) and Kubernetes
Compute fleet in the same k3d cluster. This procedure retains PostgreSQL,
Namespaces, Agents, revision history, Secrets, and Agent workspace and gateway
PersistentVolumeClaims (PVCs). Take verified backups first: retaining a volume is
not a backup, and migrations or runtime changes can make rollback unsafe.
Complete the [upgrade migration checklist](upgrade-checklist.md) before using
this procedure. Its [legacy RWX prerequisite](upgrade-checklist.md#remove-legacy-rwx-workspaces)
is an exception: explicitly discarded Agents lose their workspace and Gateway
state and must be recreated if needed. Retention checks apply to the remaining Agents.

This path requires the production Helm chart, Kubernetes Compute, and a trusted
HTTPS OCC endpoint. The [production image upgrade](production-upgrade.md) owns
the contract. Use the selected publication's source and the live installation's
inputs. A cluster from [local operations](local-operations.md) is suitable only
after the production installation sequence is complete.

`./scripts/k3d` has **no upgrade command**. Its interactive demo is a disposable
test harness, not a persistent Helm installation: it uses loopback HTTP and
creates its own topology. The production upgrade script cannot directly upgrade
that demo. Its normal Ctrl-C shutdown removes demo resources and port-forwards;
restarting creates fresh demo resources while reusing prepared infrastructure and
images. `reset` deletes its test Namespaces and replaces its database; `down`
removes its cluster and PostgreSQL resources. Do not use these commands to
upgrade or preserve a demo. See the [demo lifecycle](../../testing/kubernetes.md#develop-with-local-containers-and-k3d).

## Prepare the existing installation

- Identify the existing k3d cluster, node containers, kubeconfig, context, Helm
  release and namespace. Do not create a cluster or point at an unrelated context.
- Keep a protected, consistent PostgreSQL backup and backups of gateway and
  workspace data, Secrets, and configuration. Coordinate restore points and
  test recovery as described in [production recovery](production-handoff.md#prepare-recovery-and-update-acceptance)
  and the [storage reference](../../reference/drivers/kubernetes-compute/storage-and-credentials.md).
- Prepare the Helm values and Installation YAML for the **live** release, the
  OCC CLI, a protected service-key response and, if needed, its CA bundle.
  Files must be regular, readable files without group or other permissions. The
  script compares the YAML with live state and stops on unrelated differences.
  Do not replace the live Installation ID with another ID. Follow
  [binding the Installation](production-upgrade.md#bind-the-installation-once)
  if its Secret lacks the required annotation.
- Meet the [upgrade permissions and concurrency requirements](production-upgrade.md#prepare-the-release).
  For runtime upgrades, review saved drafts and stop other deployments and edits:
  new revisions use the current drafts. Schedule an interruption window and
  capacity for old and new workloads to overlap.
- For an installation with repository credentials enabled, run the upgrade from
  a native Linux operator environment that uses UID 1000 and the same architecture
  as every eligible control-plane node. The compatibility probe starts the staged
  controller and broker images through that environment's Docker daemon. A macOS
  shell cannot run this repository-enabled path directly; use a reviewed Linux
  operator host or container with protected access to the existing cluster and
  Docker daemon. Do not bypass the probe. Repository-disabled installations do
  not have this host requirement.
- If the bundled Collector is enabled, including the [observability demo](../observability/demo.md)'s
  `occ-demo-collector-config`, [refresh the Secret named by `logging.collector.configSecretName`](../observability.md#refresh-the-collector-configuration-on-upgrade)
  from the `RELEASE_SOURCE_SHA` checkout and restart the Collector. Helm does not
  update it, and the script stops while it differs from that checkout.

From a secure operator shell, replace placeholders with the existing paths and
names. The evidence parent must exist; the final directory must be new.

```bash
set -o pipefail
umask 077
export KUBECONFIG_FILE='/secure/occ/kubeconfig'
export CONTEXT='<existing-k3d-context>'
export NAMESPACE='<existing-helm-namespace>'
export RELEASE='<existing-helm-release>'
export VALUES='/secure/occ/values.yaml'
export INSTALLATION='/secure/occ/installation.yaml'
export OCC_URL='https://<trusted-occ-host>'
export OCC_SERVICE_KEY_FILE='/secure/occ/operator-service-key.json'
export OCC_CA_BUNDLE='/secure/occ/occ-ca.pem' # omit if the system trust store is sufficient
export UPGRADE_EVIDENCE="/secure/occ/upgrades/$(date -u +%Y%m%dT%H%M%SZ)"
```

If the retained YAML is unavailable, set `VALUES` and `INSTALLATION` to new,
protected paths before recovering the live values and Secret below. Do not
overwrite retained files. Compare the recovered files with the operator's
records; do not substitute fresh example templates.

```bash
helm --kubeconfig "$KUBECONFIG_FILE" --kube-context "$CONTEXT" \
  --namespace "$NAMESPACE" get values "$RELEASE" --output yaml > "$VALUES"
export INSTALLATION_SECRET="$(yq -er '.installation.secretName // "occ-installation-startup"' "$VALUES")"
export INSTALLATION_KEY="$(yq -er '.installation.key // "installation.yaml"' "$VALUES")"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  --namespace "$NAMESPACE" get secret "$INSTALLATION_SECRET" -o json |
  jq -er --arg key "$INSTALLATION_KEY" '.data[$key]' |
  python3 -c 'import base64,sys; sys.stdout.buffer.write(base64.b64decode(sys.stdin.buffer.read()))' > "$INSTALLATION"
chmod 600 "$VALUES" "$INSTALLATION"
```

Record the Installation ID, Agent inventory, PVC names and volume identities:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" get --raw=/readyz
helm --kubeconfig "$KUBECONFIG_FILE" --kube-context "$CONTEXT" \
  --namespace "$NAMESPACE" status "$RELEASE"
occ --output json installation get > /secure/occ/installation-before.json
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  get pvc --all-namespaces -o wide > /secure/occ/pvcs-before.txt
```

The first command returns `ok`, Helm reports the release, and OCC authenticates.
For a runtime upgrade, also save `occ --output json installation deployment-inventory`
before and after the change; that operation requires the runtime upgrade permissions.
Keep inventories private. Check data and backups with the database and storage
owners; object names alone do not prove retention.

## Select and make the published images available

In GitHub Actions, inspect **Enterprise Containers** runs on `main` in newest
first order. Select the newest successful run that actually published both
images (`publish: true`), not a no-push preparation or a partially failed run.
Download its `container-publication-<run-id>-<attempt>` receipt and compare
both entries' `sourceSha`, `destination`, and `digest` with the run input,
job summary, and successful exact-source CI. If the receipt has expired, stop until you can recover verifiable publication
evidence. See [container publication](../../../.github/containers.md#prepare-and-publish)
for the evidence and [partial publication recovery](../../../.github/containers.md#recover-a-partial-publication).
Use one verified source SHA and each full `destination@digest`; do not use
`latest`, a source tag, or a digest copied from an older example.

```bash
export RELEASE_SOURCE_SHA='<full-40-character-source-commit>'
export CONTROLLER_IMAGE='ghcr.io/openclaw/<controller-package>@sha256:<64-hex-digest>'
export RUNTIME_IMAGE='ghcr.io/openclaw/<runtime-package>@sha256:<64-hex-digest>'
export REPOSITORY_ENABLED="$(yq -er '.repositoryCredentials.enabled // false' "$VALUES")"
BROKER_ARGS=()
RUNTIME_REPOSITORY_ARGS=()
if [ "$REPOSITORY_ENABLED" = true ]; then
  # Select the reviewed broker artifact compatible with RELEASE_SOURCE_SHA.
  export BROKER_IMAGE='<registry>/repository-credentials@sha256:<64-hex-digest>'
  export CURRENT_CONTROLLER_IMAGE="$(yq -er '.images.controller' "$VALUES")"
  BROKER_ARGS=(--broker-image "$BROKER_IMAGE")
  RUNTIME_REPOSITORY_ARGS=(
    --controller-image "$CURRENT_CONTROLLER_IMAGE"
    --broker-image "$BROKER_IMAGE"
  )
fi
```

The Enterprise Containers receipt covers the controller and runtime images. A
repository-enabled release also needs separate provenance and review evidence for
`BROKER_IMAGE`; do not infer it from the runtime digest. The runtime-only command
uses the live controller digest because restarting the worker also restarts its
broker. A controller or combined release uses the selected candidate controller.

Public GHCR controller and runtime pulls do not require a registry login. If
`BROKER_IMAGE` points at a private broker package, or if you selected a private
mirror instead of public GHCR, authenticate the local registry client for that
registry before checking digests. Verify the registry's raw index bytes for each
receipt digest:

```bash
IMAGES=("$CONTROLLER_IMAGE" "$RUNTIME_IMAGE")
[ "$REPOSITORY_ENABLED" = false ] || IMAGES+=("$BROKER_IMAGE")
for image in "${IMAGES[@]}"; do
  expected="${image##*@sha256:}"
  actual="$(skopeo inspect --raw "docker://$image" | python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')"
  [ "$actual" = "$expected" ] || { echo "Registry digest mismatch: $image" >&2; exit 1; }
done
```

Public GHCR controller and runtime pulls need no node pull credentials. Configure
approved pull credentials on **every existing k3d node** only for a private
broker image or private mirror that may run OCC initialization, API, worker,
gateway, or Agent Pods. Host `docker login` alone does not authenticate those
nodes. Use the existing node credential mechanism or
[K3s private registry configuration](https://docs.k3s.io/installation/private-registry);
protect credential files and avoid putting tokens in commands, logs, or shell
history. K3s reads its registry configuration at startup: coordinate any
required node restart with the interruption window and preserve the existing
cluster and volumes. Check each node can pull the exact references before
upgrading. For Docker-backed k3d, repeat with each existing node container name;
use `podman exec` for a Podman-backed cluster:

```bash
export K3D_NODE='<existing-k3d-node-container>'
docker exec "$K3D_NODE" crictl pull "$CONTROLLER_IMAGE"
docker exec "$K3D_NODE" crictl pull "$RUNTIME_IMAGE"
[ "$REPOSITORY_ENABLED" = false ] || docker exec "$K3D_NODE" crictl pull "$BROKER_IMAGE"
```

A successful pull by digest establishes node access to that immutable reference;
resolve pull errors before continuing. Do not relabel a platform-specific local
image with the published multi-platform index digest. Local image imports and
registry index digests can differ.

## Run the upgrade

Use a separate clean checkout at `RELEASE_SOURCE_SHA`, with its chart and upgrade
script, and a compatible installed `occ` CLI. From that checkout confirm
`git rev-parse HEAD` equals `RELEASE_SOURCE_SHA`. If that source does not
contain the upgrade script, stop; this procedure cannot be run from it. Do not
overwrite a working checkout. Install `helm`, `kubectl`, `jq`, `yq` v4, and
Python 3. Use a fresh
`UPGRADE_EVIDENCE` directory for each new release; retain it when resuming an
interrupted release. The script changes the protected
input files as well as the cluster; it saves their previous contents in that
private evidence directory before cluster mutation.

Choose exactly one invocation below. Both options together perform a combined
release; omitting one leaves that image selection unchanged.

```bash
# Controller only: no Agent revisions are requested.
scripts/upgrade-production-images \
  --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  --namespace "$NAMESPACE" --release "$RELEASE" \
  --values "$VALUES" --installation "$INSTALLATION" \
  --source-revision "$RELEASE_SOURCE_SHA" --evidence-dir "$UPGRADE_EVIDENCE" \
  --controller-image "$CONTROLLER_IMAGE" "${BROKER_ARGS[@]}"

# Runtime only: use a fresh UPGRADE_EVIDENCE for a new release.
scripts/upgrade-production-images \
  --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  --namespace "$NAMESPACE" --release "$RELEASE" \
  --values "$VALUES" --installation "$INSTALLATION" \
  --source-revision "$RELEASE_SOURCE_SHA" --evidence-dir "$UPGRADE_EVIDENCE" \
  --runtime-image "$RUNTIME_IMAGE" "${RUNTIME_REPOSITORY_ARGS[@]}"

# Combined: use a fresh UPGRADE_EVIDENCE for a new release.
scripts/upgrade-production-images \
  --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  --namespace "$NAMESPACE" --release "$RELEASE" \
  --values "$VALUES" --installation "$INSTALLATION" \
  --source-revision "$RELEASE_SOURCE_SHA" --evidence-dir "$UPGRADE_EVIDENCE" \
  --controller-image "$CONTROLLER_IMAGE" --runtime-image "$RUNTIME_IMAGE" \
  "${BROKER_ARGS[@]}"
```

The helper stops the API and worker and waits for their Pods to terminate. Helm
then runs initialization, including database migration with the migrator role,
before rolling out OCC. Runtime-only also restarts OCC on its existing controller
image to load the updated Installation. The script deploys all recorded running
Agents concurrently; stopped and deleting Agents are left alone. See the
[production contract](production-upgrade.md#upgrade-agent-runtimes) for
revision, readiness, and Doctor checks.

## Verify and recover

Inspect the private evidence directory's Helm status, workload inventories,
Installation records, and, for runtime upgrades, `deployments.jsonl` and
`status/`. Confirm the selected controller digest in both API and worker
Deployment templates and their successful rollouts. For a runtime change,
confirm both image slots in the live Installation Secret, each running Agent's
new active revision, and its ready gateway/Agent Pods on the selected digest.
For controller-only, confirm existing revisions and gateways remain ready.
Inspect the live images, rollouts, initialization Job, and OCC access:

```bash
helm --kubeconfig "$KUBECONFIG_FILE" --kube-context "$CONTEXT" \
  --namespace "$NAMESPACE" status "$RELEASE"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  --namespace "$NAMESPACE" get jobs
for component in api worker; do
  kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
    --namespace "$NAMESPACE" rollout status "deployment/openclaw-enterprise-$component"
  kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
    --namespace "$NAMESPACE" get "deployment/openclaw-enterprise-$component" \
    -o "jsonpath={.spec.template.spec.containers[?(@.name=='$component')].image}{'\n'}"
done
occ --output json installation get > /secure/occ/installation-after.json
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  get pvc --all-namespaces -o wide > /secure/occ/pvcs-after.txt
```

Helm must be deployed, initialization successful, both rollouts complete, and
both displayed images equal the selected controller image (or the previous one
for runtime-only). To inspect the live runtime selection after a runtime change,
recover the Installation Secret with the commands above into a separate private
file and check `drivers.compute.configuration.images.gateway` and `.agent` with
`yq`; both must equal `RUNTIME_IMAGE`. Compare the before and after Installation ID, Namespace and
Agent inventory, PVC names and bound volumes; verify representative PostgreSQL records, Secrets,
workspace and gateway data, and a fresh model response. Pod image IDs may show
a platform-specific digest rather than the published multi-platform index.
Use [workload verification](production-agents.md#verify-production-workloads)
and the [upgrade verification](production-upgrade.md#verify-the-release) for
application checks. An empty fleet cannot prove a runtime starts.

If Helm or migration fails, inspect the initialization Job and rollouts, retain
the evidence and backups, and prefer a forward fix. Helm rollback does not undo
database migrations. If OCC succeeds but a runtime deployment fails, the fleet
can be mixed: runtime rollout is **not transactional**. Inspect each dispatch,
deployment status, and revision before retrying; an uncertain request may have
already created a revision. Check compatibility before selecting an older image
or restoring state, and follow [partial-failure recovery](production-upgrade-recovery.md).
Do not delete the cluster, database volume, Namespaces, Agents, revisions,
Secrets, bootstrap volume, or Agent PVCs to force an upgrade or recovery.
