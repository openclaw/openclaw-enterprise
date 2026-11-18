# Runbook: build and install detail for steps 1 to 6

Detail for steps 1 to 6 of the [runbook](RUNBOOK.md). Blocks marked **ran**
were run as written on 2026-11-18: the host and build commands in a fresh
Ubuntu 24.04 x86-64 container (as root, so without `sudo`), the image builds
with Docker Buildx on an x86-64 build machine. Blocks marked **not executed** were checked against
this branch and the proven installation, not run as written. Nothing here
was run on an empty host with K3s.

## Prerequisites

| For             | What                                                                                             | Step |
| --------------- | ------------------------------------------------------------------------------------------------ | ---- |
| Box build       | `rustup` (the fork's `rust-toolchain.toml` selects Rust 1.98.1), `build-essential`, `pkg-config` | 2    |
| Verifier        | Go 1.27.3 (`go.mod`)                                                                             | 2    |
| OCE checkout    | Node 24.22.1 with corepack (pnpm 11.15.1 from `packageManager`)                                  | 1    |
| Images          | Docker with Buildx; a package registry for the Driver (below)                                    | 3    |
| Install         | `kubectl`, Helm, `yq` v4, the [OCC CLI](../../../docs/guides/cli.md)                             | 4    |
| Database        | PostgreSQL 18 (18.6 or later) with TLS and two roles                                             | 4    |
| Cluster add-ons | Gateway API CRDs, Envoy Gateway with a GatewayClass, cert-manager                                | 4    |

## Step 1: Node with corepack (ran)

Installing only `bin/node` leaves no `corepack`. From the extracted
`node-v24.22.1-linux-x64` directory, after checking it against Node's
`SHASUMS256.txt`:

```bash
sudo install -o root -g root -m 0755 node-v24.22.1-linux-x64/bin/node /usr/local/bin/node
sudo install -d /usr/local/lib/node_modules
sudo cp -a node-v24.22.1-linux-x64/lib/node_modules/corepack /usr/local/lib/node_modules/
sudo ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack
sudo corepack enable
git clone --branch demo/strands-box-one-repo https://github.com/openclaw/openclaw-enterprise.git
cd openclaw-enterprise && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile
```

## Step 2: Box, verifier and host helper (ran)

The `cargo build` in [Which Box build](README.md#which-box-build) took 96
seconds after the toolchain above and leaves all three programs in
`target/release`. Install them side by side in `<box-dir>`, a directory the
`strands-box` AppArmor profile's glob matches (the runs: an operator-owned
directory under the operator's home). Then:

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -buildvcs=false \
  -ldflags='-s -w -buildid=' -o "$STAGING/oce-workspace-verifier" \
  ./deploy/examples/strands-box/workspace-verifier
sha256sum "$STAGING/oce-workspace-verifier"   # the host's workspaceVerifierSha256
pnpm exec tsc -p deploy/examples/strands-box/host/tsconfig.agent.json --outDir "$STAGING/agent"
sudo install -d -m 0755 /opt/oce-box/compiled-agent
sudo cp -a "$STAGING/agent/." /opt/oce-box/compiled-agent/ && sudo chown -R root:root /opt/oce-box
sudo install -D -m 0755 "$STAGING/oce-workspace-verifier" /opt/demo/verifier/oce-workspace-verifier
```

Without the `install -d`, the `cp` fails. For `gh`, check
`gh_2.103.2_linux_amd64.tar.gz` against `gh_2.103.2_checksums.txt` from the
`cli/cli` release and install its `bin/gh` at `/usr/local/bin/gh`.

## Step 3: images

### Runtime (ran)

The [runtime recipe](../../runtime/README.md#build-a-local-runtime-image)'s
`docker build` with `--platform linux/amd64` added. It compiles Node and
curl from source: 22 minutes on a large build machine.

### Controller with the Driver (ran)

The [package identity rule](../../../docs/reference/drivers/selection.md#package-identity-and-factory-exports)
needs the Driver at exact version `0.1.6` in `apps/controller/package.json`
and `pnpm-lock.yaml`. The package is in no public registry (`pnpm add`
fails with `ERR_PNPM_FETCH_404`), and the Controller refuses a `file:`
dependency. Publish the packed archive to a private registry you run, then:

```bash
printf '@openclaw-enterprise:registry=%s\n' "<registry-url>" > "$PRIVATE/npmrc"
export NPM_CONFIG_USERCONFIG="$PRIVATE/npmrc"
pnpm publish deploy/examples/strands-box/driver/openclaw-enterprise-example-strands-box-driver-0.1.6.tgz \
  --registry "<registry-url>" --no-git-checks
printf 'minimumReleaseAgeExclude:\n  - "@openclaw-enterprise/example-strands-box-driver"\n' >> pnpm-workspace.yaml
pnpm --dir apps/controller add --save-exact --save-prod @openclaw-enterprise/example-strands-box-driver@0.1.6
NODE_BASE_IMAGE="$(yq -p=json -e -r '.prepare.defaultEnv.NODE_BASE_IMAGE' scripts/ci/test-suites/images-packaging.json)"
docker buildx build --load --platform linux/amd64 --target runtime \
  --secret id=npmrc,src="$PRIVATE/npmrc" --build-arg NODE_BASE_IMAGE="$NODE_BASE_IMAGE" \
  --build-arg OCC_BUILD_REVISION="$(git rev-parse HEAD)" -t <controller> .
```

Without the `minimumReleaseAgeExclude` entry, `pnpm add` refuses the fresh
publish (`ERR_PNPM_NO_MATURE_MATCHING_VERSION`): the workspace accepts
registry releases only after seven days. The build machine's BuildKit must
reach the registry. The build took 84 seconds, and the step 3 import check
exited 0. The proven runs instead copied the unpacked package into
the stock image ([not covered](RUNBOOK-TROUBLESHOOTING.md#not-covered)).

### Relay (ran)

`NODE_IMAGE` is the Node base the root `Dockerfile` pins:

```bash
docker buildx build --load --platform linux/amd64 \
  -f deploy/examples/strands-box/ingress/relay.Dockerfile \
  --build-arg NODE_IMAGE=docker.io/library/node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 \
  -t <relay> deploy/examples/strands-box/ingress
```

### Images into K3s (not executed)

Without a registry, the proven runs saved each image as an archive on the
host and imported it with `sudo k3s ctr -n k8s.io images import <archive>`.
`ctr` records only the tag, so they also tagged `<name>@<digest>` with
`sudo k3s ctr -n k8s.io images tag`, the digest from
`sudo k3s ctr -n k8s.io images ls`, and used that reference everywhere.

### Runtime files on the host (ran, under a scratch root)

```bash
cid=$(docker create --platform linux/amd64 <runtime>)
sudo docker cp "$cid:/app" /app
sudo install -d -m 0755 /opt/oce
sudo docker cp "$cid:/opt/oce/runtime" /opt/oce/runtime
sudo docker cp "$cid:/usr/bin/tini" /usr/bin/tini
sudo chown -R root:root /app /opt/oce /usr/bin/tini
sudo install -d -o "$USER" -g "$USER" -m 0700 /srv/oce-file-node /srv/oce-file-node/runtime
docker export "$cid" | tar -x -C /srv/oce-file-node/runtime
: > /srv/oce-file-node/runtime/etc/hosts
docker rm "$cid"
```

Under the scratch root, `tar` reported no error as a nonroot user, and the
step 3 `CODEX` glob resolved to Codex 0.164.0, whose `--version` ran.

## Step 4: install (not executed)

What the proven installation used, beside the
[production installation](../../../docs/guides/deploy/production-installation.md):

- K3s v1.35.9+k3s1, its server started with `--disable` for `traefik`,
  `servicelb`, `metrics-server` and `local-storage`. Without the last one,
  K3s makes `local-path` the default StorageClass, which step 8's workspace
  claim must not get. Pre-created volumes used a
  `kubernetes.io/no-provisioner` StorageClass.
- PostgreSQL 18 on the host, TLS from its own CA, the two roles and URLs of
  [the system Secrets](../../../docs/guides/deploy/production-installation-preparation.md),
  and Helm `database.cidrs` for the host address.
- Release `oce` in namespace `oce-system`. `controlPlane.nodeSelector` and
  the Installation's `drivers.compute.configuration.runtime.gatewayNodeSelector`
  and `runtime.nodeSelector` all set to `kubernetes.io/hostname: <node>`.
- The Gateway route: Helm `gatewayRouting.hostname` set to the DNS name of a
  ClusterIP Service in `envoy-gateway-system` on port `10443` that selects
  the Gateway's Envoy Pods (`app.kubernetes.io/component: proxy`,
  `app.kubernetes.io/managed-by: envoy-gateway`, `app.kubernetes.io/name: envoy`,
  `gateway.envoyproxy.io/owning-gateway-name: <gatewayName>`,
  `gateway.envoyproxy.io/owning-gateway-namespace: oce-system`), and
  `gatewayRouting.endpointPort: 10443` in the Installation's Compute
  configuration ([workspace routing](../../../docs/guides/deploy/workspace-routing.md)).
- `OCC_SERVICE_KEY_FILE` is the bootstrap claim's
  `initial-admin-service-key.json`
  ([authenticate](../../../docs/guides/deploy/production-installation.md#authenticate-to-the-production-api)).
  `request GET /namespaces` lists the Namespace ID.

## Step 5: objects (not executed, except the certificates)

`<agent-ns>` is the Kubernetes namespace the Worker created for the OCE
Namespace:
`kubectl get ns -l openclaw.dev/namespace=<namespace-id> -o name`.

The Worker egress policy and the control claim, as the runs had them:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: worker-to-box-relay, namespace: oce-system }
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/component: worker
      app.kubernetes.io/instance: oce
      app.kubernetes.io/name: openclaw-enterprise
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: <agent-ns> }
          podSelector:
            matchLabels:
              box.openclaw.dev/component: harness-relay
              box.openclaw.dev/installation: <label>
      ports: [{ protocol: TCP, port: 8443 }]
---
apiVersion: v1
kind: PersistentVolume
metadata: { name: strands-box-control }
spec:
  capacity: { storage: 1Mi }
  accessModes: [ReadWriteOnce]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: <no-provisioner class>
  volumeMode: Filesystem
  local: { path: /run/oce-box/revision/worker-control }
  claimRef: { namespace: oce-system, name: strands-box-control }
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - { key: kubernetes.io/hostname, operator: In, values: [<node>] }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: strands-box-control, namespace: oce-system }
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 1Mi } }
  storageClassName: <no-provisioner class>
  volumeName: strands-box-control
```

Create `/run/oce-box/revision/worker-control` (each level `0700`, owned by
the operator) before the claim checks; `/run` is emptied at reboot.

Certificates (ran): one CA and a leaf per name. Host ingress takes the leaf
followed by the CA as its chain file; `nativeCaBundle` is the CA.

```bash
umask 077
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 \
  -subj "/CN=box test CA" -addext basicConstraints=critical,CA:TRUE,pathlen:0 \
  -addext keyUsage=critical,keyCertSign,cRLSign -keyout ca.key -out ca.pem
leaf() {
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$1" \
    -keyout "$1.key" -out "$1.csr"
  printf 'subjectAltName=DNS:%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n' "$1" > "$1.ext"
  openssl x509 -req -in "$1.csr" -CA ca.pem -CAkey ca.key -CAcreateserial -days 29 \
    -extfile "$1.ext" -out "$1.pem"
}
leaf "box-harness.<agent-ns>.svc.cluster.local"
leaf model.example.test
cat "box-harness.<agent-ns>.svc.cluster.local.pem" ca.pem > ingress-chain.pem
```

## Step 6: the registry (ran in part)

Step 6's `jq` output, with sample IDs, passed the Controller's registry
loader, and the `api.github.com/meta` line printed 125 IPv4 ranges. The
ConfigMap, the Secrets and the Helm values were not executed.
