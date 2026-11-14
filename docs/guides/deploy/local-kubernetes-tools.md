# Install the local Kubernetes tools on Linux

Start from the OCE checkout on a Linux AMD64 or ARM64 host with Bash, sudo access and space for the container images. Install the host tools globally so a fresh shell can resume the quickstart.

## Prepare Docker and host utilities

Choose your Linux distribution, then run the Docker checks below.

<AccordionGroup>
<Accordion title="Ubuntu">

Follow the [Docker Engine installation instructions for Ubuntu](https://docs.docker.com/engine/install/ubuntu/), including the Buildx plugin. Start Docker, then install the host utilities:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git jq openssl tar xz-utils
```

</Accordion>
<Accordion title="Fedora 44">

Follow the [Docker Engine installation instructions for Fedora](https://docs.docker.com/engine/install/fedora/), including the Buildx plugin. Start Docker, then install the host utilities:

```bash
sudo dnf install -y ca-certificates /usr/bin/curl git jq openssl tar xz
```

</Accordion>
</AccordionGroup>

Run these commands as the account that will start k3d:

```bash
docker version --format '{{.Server.Version}}'
docker buildx version
```

[Docker socket permission denied?](https://docs.docker.com/engine/install/linux-postinstall/#manage-docker-as-a-non-root-user) Docker group membership grants root-level access.

## Install Node, pnpm, Go and the Kubernetes tools

[Downloading packages through an HTTP proxy?](../operate/local-setup-troubleshooting.md#corepack-cannot-download-pnpm-through-a-proxy)

Download the Node and Go versions pinned for this release into a temporary directory. The repository download helper checks each archive against its SHA-256 before extraction. Install them under `/opt/oce-tools` and link their commands into `/usr/local/bin`. This replaces any existing commands with the same names in `/usr/local/bin`. Run the remaining blocks in a child Bash shell so a failed installation returns you to your original shell.

```bash
bash --noprofile --norc
```

```bash
set -euo pipefail
umask 077
tools=$(mktemp -d)
# Select the checksums for the host architecture.
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
install_root=/opt/oce-tools
sudo install -d -m 755 "$install_root" "$install_root/go1.27.3" /usr/local/bin
sudo tar --no-same-owner --same-permissions -xf "$tools/node.tar.xz" -C "$install_root"
sudo tar --no-same-owner --same-permissions -xf "$tools/go.tar.gz" \
  --strip-components=1 -C "$install_root/go1.27.3"
for command in node npm npx corepack; do
  sudo ln -sfn "$install_root/$node_dir/bin/$command" "/usr/local/bin/$command"
done
for command in go gofmt; do
  sudo ln -sfn "$install_root/go1.27.3/bin/$command" "/usr/local/bin/$command"
done
export PATH="/usr/local/bin:$PATH"
sudo env PATH="/usr/local/bin:/usr/bin:/bin" corepack enable --install-directory /usr/local/bin pnpm
```

Use the repository's k3d tool installer. It checks the Docker daemon and downloads checksum-verified kubectl, k3d, Helm and yq when they cannot be reused from `PATH`. On Linux, k3d and yq reuse requires bytes matching the repository's platform checksum; kubectl and Helm reuse matches the pinned version. Copy the selected binaries into `/usr/local/bin`. Corepack reads the pnpm version and integrity hash from the checkout's `package.json`; run pnpm as your operator account so its cache remains user-owned.

```bash
# Stage the pinned tools, then install them globally.
RUNNER_TEMP="$tools" bash scripts/ci/setup-tools.sh k3d
for command in kubectl k3d helm yq; do
  binary=$(PATH="$tools/bin:$PATH" command -v "$command")
  if [[ $binary != "/usr/local/bin/$command" ]]; then
    sudo install -m 755 "$binary" "/usr/local/bin/$command"
  fi
done
rm -rf -- "$tools"

# Verify without shell startup files or the temporary download directory.
env PATH="/usr/local/bin:/usr/bin:/bin" bash --noprofile --norc <<'BASH'
set -euo pipefail
for command in node go pnpm kubectl k3d helm yq; do command -v "$command"; done
node --version
go version
pnpm --version
kubectl version --client
k3d version
helm version --short
yq --version
BASH
```

After the checks succeed, type `exit` in the child shell to return to the original shell for installation.

Expect Node 24.22.1, Go 1.27.3, pnpm 11.15.1, kubectl 1.35.0, k3d 5.8.3, Helm 3.19.2 and yq 4.48.1 for this release. When selecting another source checkout, compare its `mise.toml`, `go.mod` and `package.json` before continuing. Keep TLS verification enabled for all downloads. Retain `/opt/oce-tools` and the commands in `/usr/local/bin` when cleaning up an installation; saved operator sessions use these tools.
