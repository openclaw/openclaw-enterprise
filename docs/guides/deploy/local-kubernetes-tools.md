# Install the local Kubernetes tools on Linux

Use these commands in Bash on a Linux AMD64 or ARM64 host. Start from the OCE checkout with a working Docker Engine and enough disk space for the images. Keep this shell open through image selection and Agent deployment so the tools remain on `PATH`.

On Ubuntu, install the base utilities if they are missing. If Docker is missing, follow [Docker Engine for Ubuntu](https://docs.docker.com/engine/install/ubuntu/) and check access from your operator account. Authenticate the GitHub reader with your approved account for the independent repository check.

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git gh jq openssl tar xz-utils
docker version --format '{{.Server.Version}}'
gh auth status
```

Install the Node and Go versions pinned for this release into a new user-owned directory. The repository download helper checks each archive against its SHA-256 before extracting it.

```bash
set -euo pipefail
umask 077
tools=$(mktemp -d)
case "$(uname -m)" in
  x86_64)
    node_arch=x64; go_arch=amd64
    node_sha=6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6
    go_sha=65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40 ;;
  aarch64|arm64)
    node_arch=arm64; go_arch=arm64
    node_sha=dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e
    go_sha=a06e99309dbcbdca1a8ccd2282c3ee146e55930886e26b4f1193269587165f49 ;;
  *) echo "Unsupported architecture" >&2; exit 1 ;;
esac
node_dir=node-v24.22.1-linux-$node_arch
bash scripts/ci/download-pinned.sh "https://nodejs.org/dist/v24.22.1/$node_dir.tar.xz" \
  "$tools/node.tar.xz" "$node_sha"
bash scripts/ci/download-pinned.sh "https://go.dev/dl/go1.27.3.linux-$go_arch.tar.gz" \
  "$tools/go.tar.gz" "$go_sha"
tar -xf "$tools/node.tar.xz" -C "$tools"
tar -xf "$tools/go.tar.gz" -C "$tools"
mkdir "$tools/bin"
export PATH="$tools/bin:$tools/$node_dir/bin:$tools/go/bin:$PATH"
corepack enable --install-directory "$tools/bin" pnpm
```

Use the repository's k3d tool installer. It checks the Docker daemon and installs checksum-verified kubectl, k3d, Helm and yq. Corepack reads the pnpm version and integrity hash from the checkout's `package.json`.

```bash
RUNNER_TEMP="$tools" bash scripts/ci/setup-tools.sh k3d
node --version
go version
pnpm --version
kubectl version --client
k3d version
helm version --short
```

Expect Node 24.22.1, Go 1.27.3, pnpm 11.15.1, kubectl 1.35.0, k3d 5.8.3 and Helm 3.19.2 for this release. When selecting another source checkout, compare its `mise.toml`, `go.mod` and `package.json` before continuing. Keep TLS verification enabled for all downloads.
