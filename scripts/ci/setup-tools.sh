#!/usr/bin/env bash
set -euo pipefail

profile="${1:-baseline}"
root_dir="$(CDPATH="" cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
platform="$(/usr/bin/uname -s)-$(/usr/bin/uname -m)"
bin_dir="$(/usr/bin/python3 -I -S - "${RUNNER_TEMP:-}" <<'PYTHON'
import os
from pathlib import Path
import pwd
import stat
import sys

uid = os.geteuid()
system_owner = Path("/").stat().st_uid


def safe_directory(original):
    if not original.is_absolute() or not str(original).isprintable() or ".." in original.parts:
        raise ValueError
    # Account for system-owned Darwin aliases such as /var and /tmp.
    for component in (original, *original.parents):
        if not component.is_symlink():
            continue
        if component.lstat().st_uid != system_owner or any(
            parent.lstat().st_uid != system_owner or parent.lstat().st_mode & 0o022
            for parent in component.parents
        ):
            raise ValueError
        target = component.parent / os.readlink(component)
        if any(path.is_symlink() for path in (target, *target.parents)):
            raise ValueError
    physical = original.resolve(strict=True)
    if not str(physical).isprintable():
        raise ValueError
    for component in (physical, *physical.parents):
        info = component.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid not in {uid, system_owner}:
            raise ValueError
        if info.st_mode & 0o022 and not (info.st_mode & stat.S_ISVTX and component != physical):
            raise ValueError
    if physical.stat().st_uid != uid:
        raise ValueError
    return physical


def owned_subdirectory(parent, name, *, private=True):
    if not name or not name.isprintable():
        raise ValueError
    child = parent / name
    directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if not os.path.samestat(os.fstat(directory), parent.stat()):
            raise ValueError
        try:
            os.mkdir(name, mode=0o700, dir_fd=directory)
        except FileExistsError:
            pass
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
        try:
            info = os.fstat(fd)
            if info.st_uid != uid or info.st_mode & 0o022 or not os.path.samestat(info, child.stat()):
                raise ValueError
            if private:
                os.fchmod(fd, 0o700)
        finally:
            os.close(fd)
    finally:
        os.close(directory)
    return child


def local_tool_directory():
    configured = os.environ.get("XDG_CACHE_HOME")
    if configured:
        cache = Path(configured)
        if not cache.is_absolute() or not configured.isprintable() or ".." in cache.parts:
            raise ValueError
        if cache.exists() or cache.is_symlink():
            cache = safe_directory(cache)
        else:
            cache = owned_subdirectory(safe_directory(cache.parent), cache.name, private=False)
    else:
        home = safe_directory(Path(pwd.getpwuid(uid).pw_dir))
        cache = owned_subdirectory(home, ".cache", private=False)
    app_cache = owned_subdirectory(cache, "openclaw-enterprise", private=False)
    return owned_subdirectory(app_cache, "ci-tools")


try:
    root = safe_directory(Path(sys.argv[1])) if sys.argv[1] else local_tool_directory()
    print(owned_subdirectory(root, "bin"))
except (KeyError, OSError, RuntimeError, ValueError):
    sys.exit("CI tool setup requires an owner-controlled RUNNER_TEMP or local cache and a physical private bin directory.")
PYTHON
)"

CDPATH="" cd "${root_dir}"
export PATH="${bin_dir}:${PATH}"

need_command() {
  local name="$1"
  if ! command -v "${name}" >/dev/null 2>&1; then
    echo "Missing required command: ${name}" >&2
    return 1
  fi
}

# Keep verification, transport, and the kubectl probe off the caller's PATH
# and away from shell startup files and exported functions.
run_system_tool() {
  /usr/bin/python3 -I -S -c '
import os
import sys

program = sys.argv[1]
if not os.path.isabs(program):
    sys.exit("CI tool setup requires an absolute tool path")
environment = {"PATH": "/usr/bin:/bin", "LC_ALL": "C"}
for name in (
    "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy",
    "CURL_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR",
):
    if name in os.environ:
        environment[name] = os.environ[name]
os.execve(program, sys.argv[1:], environment)
  ' "$@"
}

download_file() {
  run_system_tool /bin/bash "${root_dir}/scripts/ci/download-pinned.sh" "$@"
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
    Linux-*)
      if [[ "${tool}" == yq || "${tool}" == k3d ]]; then
        echo "No supported checksum pin for ${tool} v${version} on ${platform}." >&2
      else
        echo "Install ${tool} v${version} manually on ${platform}." >&2
      fi
      return 1
      ;;
    *)
      echo "Install ${tool} v${version} manually on ${platform}." >&2
      return 1
      ;;
  esac
}

install_kubectl() {
  local operating_system arch pins version checksum existing
  case "${platform}" in
    Linux-x86_64) operating_system=linux; arch=amd64 ;;
    Linux-aarch64|Linux-arm64) operating_system=linux; arch=arm64 ;;
    Darwin-x86_64) operating_system=darwin; arch=amd64 ;;
    Darwin-arm64|Darwin-aarch64) operating_system=darwin; arch=arm64 ;;
    *)
      echo "No repository kubectl checksum for ${platform}; use Linux or Darwin on x86_64 or arm64." >&2
      return 1
      ;;
  esac
  pins="$(/usr/bin/python3 -I - "${root_dir}/scripts/ci/kubectl-pins.json" "${operating_system}" "${arch}" <<'PYTHON'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as manifest:
    pins = json.load(manifest)
version = pins["version"]
checksum = pins[sys.argv[2]][sys.argv[3]]
if re.fullmatch(r"\d+\.\d+\.\d+", version) is None or re.fullmatch(r"[a-f0-9]{64}", checksum) is None:
    sys.exit("Invalid kubectl pins")
print(version, checksum)
PYTHON
)"
  read -r version checksum <<< "${pins}"
  local binary="${bin_dir}/kubectl"
  existing="$(type -P kubectl || true)"
  # The downloader verifies a private copy of the PATH candidate before reuse.
  download_file \
    "https://dl.k8s.io/release/v${version}/bin/${operating_system}/${arch}/kubectl" \
    "${binary}" "${checksum}" "${CI_PINNED_TOOL_CACHE:-}" "${existing}" 0755
  run_system_tool "${binary}" version --client=true
}

install_k3d() {
  local version="5.8.3"
  if [[ "${platform}" != Linux-* ]] && k3d_version_matches "${version}"; then
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
    "${checksum}" \
    "${CI_PINNED_TOOL_CACHE:-}" \
    "$(type -P k3d || true)" \
    0755
  "${binary}" version
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
  if [[ "${platform}" != Linux-* ]] && yq_version_matches "${version}"; then
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
    "${checksum}" \
    "${CI_PINNED_TOOL_CACHE:-}" \
    "$(type -P yq || true)" \
    0755
  "${binary}" --version
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
    # An explicitly selected, already-installed browser is validated below.
    # Installing a second Chromium and its dependencies does not prepare that binary.
    if [[ -z "${OCC_TEST_BROWSER_EXECUTABLE:-}" ]]; then
      pnpm exec playwright install --with-deps --only-shell chromium
    fi
    if [[ -n "${OPENCLAW_CI_NATIVE_BROWSER_EVIDENCE_DIR:-}" ]]; then
      # Host Chrome does not install Playwright's pinned video encoder.
      pnpm exec playwright install ffmpeg
    fi
    if [[ -n "${OCC_TEST_BROWSER_EXECUTABLE:-}" ]]; then
      if [[ ! -x "${OCC_TEST_BROWSER_EXECUTABLE}" ]]; then
        echo "Selected CI browser executable is unavailable." >&2
        return 1
      fi
      # A system browser does not include Playwright's video recorder binary.
      pnpm exec playwright install ffmpeg
      # Verify the selected host browser before building runtime images. Keep job
      # credentials out of its environment and preserve Chromium's sandbox.
      node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const directory = await mkdtemp(join(tmpdir(), "oce-ci-browser-"));
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.OCC_TEST_BROWSER_EXECUTABLE,
    headless: true,
    chromiumSandbox: true,
    env: { HOME: directory, PATH: process.env.PATH, TMPDIR: directory },
  });
  const page = await browser.newPage();
  assert.equal(await page.evaluate(() => 1 + 1), 2);
  console.log(`Sandboxed CI browser: ${browser.version()}`);
} finally {
  await browser?.close();
  await rm(directory, { recursive: true, force: true });
}
NODE
    fi
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
    install_yq
    need_command jq
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
  podman)
    need_command podman
    need_command podman-compose
    podman info >/dev/null
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
elif [[ -z "${RUNNER_TEMP:-}" ]]; then
  printf 'Use the verified tools in your current shell with this command\nexport PATH=%q:"$PATH"\n' "${bin_dir}" >&2
fi
