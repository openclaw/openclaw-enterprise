#!/usr/bin/env bash
set -euo pipefail

lane="${1:?CI lane is required}"

verify_skopeo() {
  local version
  version="$(timeout --kill-after=5s 10s skopeo --version)" || return "$?"
  printf '%s\n' "$version"
  if [[ "$lane" == images-packaging && "$version" != 'skopeo version 1.13.3' ]]; then
    echo 'Expected skopeo version 1.13.3 for images-packaging' >&2
    return 1
  fi
}

if command -v skopeo >/dev/null 2>&1 && verify_skopeo; then
  exit 0
fi

# Keep the runner's repositories and signature checks. Per-request timeouts do
# not bound a whole index refresh, so each APT operation also has a wall limit.
apt_options=(
  -o Acquire::Retries=3
  -o Acquire::http::Timeout=20
  -o Acquire::https::Timeout=20
  -o APT::Update::Error-Mode=any
)
sudo -n timeout --kill-after=10s 120s apt-get "${apt_options[@]}" update
sudo -n timeout --kill-after=10s 120s apt-get "${apt_options[@]}" install --no-install-recommends -y skopeo
verify_skopeo
