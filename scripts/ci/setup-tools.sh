#!/usr/bin/env bash
set -euo pipefail

profile="${1:-baseline}"
root_dir="$(CDPATH="" cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bin_dir="${RUNNER_TEMP:-/tmp/claw-ent-ci-implementation}/bin"
platform="$(uname -s)-$(uname -m)"

mkdir -p "${bin_dir}"
CDPATH="" cd "${root_dir}"
export PATH="${bin_dir}:${PATH}"

need_command() {
  local name="$1"
  if ! command -v "${name}" >/dev/null 2>&1; then
    echo "Missing required command: ${name}" >&2
    return 1
  fi
}

# Retries transient network failures, then verifies the pinned SHA-256.
download_file() {
  bash "${root_dir}/scripts/ci/download-pinned.sh" "$@"
}

k3d_version_matches() {
  local version="$1"
  local current=""
  if ! command -v k3d >/dev/null 2>&1; then
    return 1
  fi
  current="$(k3d version 2>/dev/null | awk '$1 == "k3d" && $2 == "version" { print $3; exit }')"
  [[ "${current}" == "v${version}" ]]
}

helm_version_matches() {
  local version="$1"
  local current=""
  if ! command -v helm >/dev/null 2>&1; then
    return 1
  fi
  current="$(helm version --short 2>/dev/null)"
  current="${current%%+*}"
  [[ "${current}" == "v${version}" ]]
}

yq_version_matches() {
  local version="$1"
  local current=""
  if ! command -v yq >/dev/null 2>&1; then
    return 1
  fi
  current="$(yq --version 2>/dev/null)"
  current="${current##* }"
  [[ "${current}" == "v${version}" ]]
}

actionlint_version_matches() {
  local version="$1"
  local current=""
  if ! command -v actionlint >/dev/null 2>&1; then
    return 1
  fi
  current="$(actionlint -version 2>/dev/null | sed -n '1p')"
  [[ "${current}" == "${version}" ]]
}

kubectl_version_matches() {
  local version="$1"
  local current=""
  if ! command -v kubectl >/dev/null 2>&1; then
    return 1
  fi
  current="$(kubectl version --client=true -o json 2>/dev/null | node -e 'let input = ""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => { const version = JSON.parse(input).clientVersion?.gitVersion; if (version) console.log(version); });' 2>/dev/null || true)"
  [[ "${current}" == "v${version}" ]]
}

linux_amd64_or_manual() {
  local tool="$1"
  if [[ "${platform}" != "Linux-x86_64" ]]; then
    echo "${tool} auto-install is pinned for Linux x86_64 CI only; install ${tool} locally or provide it on PATH." >&2
    return 1
  fi
}

require_node() {
  need_command node
  node <<'NODE'
const [major, minor, patch] = process.versions.node.split(".").map(Number);
if (
  major < 24 ||
  (major === 24 && (minor < 22 || (minor === 22 && patch < 1))) ||
  (major === 26 && (minor < 12 || (minor === 12 && patch < 1)))
) {
  throw new Error(`Node >=24.22.1 (26.x >=26.12.1) is required; found ${process.versions.node}.`);
}
NODE
}

require_docker() {
  need_command docker
  docker version --format '{{.Server.Version}}'
}

select_linux_artifact() {
  local platform="$1" tool="$2" version="$3" amd64_artifact="$4" arm64_artifact="$5"
  case "${platform}" in
    Linux-x86_64) printf '%s\n' "${amd64_artifact}" ;;
    Linux-aarch64|Linux-arm64) printf '%s\n' "${arm64_artifact}" ;;
    *)
      echo "Install ${tool} v${version} manually on ${platform}." >&2
      return 1
      ;;
  esac
}

install_kubectl() {
  local version="1.35.0"
  if kubectl_version_matches "${version}"; then
    kubectl version --client=true
    return
  fi
  local artifact arch checksum
  artifact="$(select_linux_artifact "${platform}" kubectl "${version}" \
    "amd64 a2e984a18a0c063279d692533031c1eff93a262afcc0afdc517375432d060989" \
    "arm64 58f82f9fe796c375c5c4b8439850b0f3f4d401a52434052f2df46035a8789e25")" || return
  read -r arch checksum <<< "${artifact}"
  local binary="${bin_dir}/kubectl"
  download_file \
    "https://dl.k8s.io/release/v${version}/bin/linux/${arch}/kubectl" \
    "${binary}" \
    "${checksum}"
  chmod 0755 "${binary}"
  kubectl version --client=true
}

install_k3d() {
  local version="5.8.3"
  if k3d_version_matches "${version}"; then
    k3d version
    return
  fi
  local artifact arch checksum
  artifact="$(select_linux_artifact "${platform}" k3d "${version}" \
    "amd64 dbaa79a76ace7f4ca230a1ff41dc7d8a5036a8ad0309e9c54f9bf3836dbe853e" \
    "arm64 0b8110f2229631af7402fb828259330985918b08fefd38b7f1b788a1c8687216")" || return
  read -r arch checksum <<< "${artifact}"
  local binary="${bin_dir}/k3d"
  download_file \
    "https://github.com/k3d-io/k3d/releases/download/v${version}/k3d-linux-${arch}" \
    "${binary}" \
    "${checksum}"
  chmod 0755 "${binary}"
  k3d version
}

install_helm() {
  local version="3.19.2"
  if helm_version_matches "${version}"; then
    helm version --short
    return
  fi
  local artifact arch checksum
  artifact="$(select_linux_artifact "${platform}" Helm "${version}" \
    "amd64 2114c9dea2844dce6d0ee2d792a9aae846be8cf53d5b19dc2988b5a0e8fec26e" \
    "arm64 566e9f3a5a83a81e4b03503ae37e368edd52d699619e8a9bb1fdf21561ae0e88")" || return
  read -r arch checksum <<< "${artifact}"
  local archive="${bin_dir}/helm-v${version}-linux-${arch}.tar.gz"
  download_file \
    "https://get.helm.sh/helm-v${version}-linux-${arch}.tar.gz" \
    "${archive}" \
    "${checksum}"
  tar -xzf "${archive}" -C "${bin_dir}" "linux-${arch}/helm"
  mv "${bin_dir}/linux-${arch}/helm" "${bin_dir}/helm"
  rmdir "${bin_dir}/linux-${arch}"
  chmod 0755 "${bin_dir}/helm"
  helm version --short
}

install_yq() {
  local version="4.48.1"
  if yq_version_matches "${version}"; then
    yq --version
    return
  fi
  local artifact arch checksum
  artifact="$(select_linux_artifact "${platform}" yq "${version}" \
    "amd64 99df6047f5b577a9d25f969f7c3823ada3488de2e2115b30a0abb10d9324fd9f" \
    "arm64 0e46b5b926a9e57c526fa2bd8f8e38b7e17fbf6e2403ff1741f3b268e3363a9e")" || return
  read -r arch checksum <<< "${artifact}"
  local binary="${bin_dir}/yq"
  download_file \
    "https://github.com/mikefarah/yq/releases/download/v${version}/yq_linux_${arch}" \
    "${binary}" \
    "${checksum}"
  chmod 0755 "${binary}"
  yq --version
}

install_actionlint() {
  local version="1.7.7"
  if actionlint_version_matches "${version}"; then
    actionlint -version
    return
  fi
  linux_amd64_or_manual actionlint
  local archive="${bin_dir}/actionlint_${version}_linux_amd64.tar.gz"
  download_file \
    "https://github.com/rhysd/actionlint/releases/download/v${version}/actionlint_${version}_linux_amd64.tar.gz" \
    "${archive}" \
    "023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757"
  tar -xzf "${archive}" -C "${bin_dir}" actionlint
  chmod 0755 "${bin_dir}/actionlint"
  actionlint -version
}

install_browser_dependencies() {
  if [[ -n "${CI:-}" ]]; then
    need_command pnpm
    # Every test launches Chromium headless, which runs the headless shell, so
    # skip the full Chrome for Testing download (about 190 MB, 7 s).
    pnpm exec playwright install --with-deps --only-shell chromium
  else
    echo "Skipping local browser installation; browser setup is CI-only." >&2
  fi
}

require_node

case "${profile}" in
  baseline)
    need_command git
    need_command tar
    need_command pnpm
    ;;
  browser)
    install_browser_dependencies
    ;;
  postgres)
    require_docker
    ;;
  images)
    require_docker
    install_helm
    install_yq
    ;;
  k3d)
    require_docker
    install_kubectl
    install_k3d
    install_helm
    install_yq
    ;;
  full)
    require_docker
    install_kubectl
    install_k3d
    install_helm
    install_yq
    ;;
  workflows)
    install_actionlint
    ;;
  *)
    echo "Unknown setup profile: ${profile}" >&2
    exit 64
    ;;
esac

if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "OPENCLAW_ENTERPRISE_CI_BIN=${bin_dir}" >>"${GITHUB_ENV}"
fi
if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "${bin_dir}" >>"${GITHUB_PATH}"
fi
