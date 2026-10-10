#!/usr/bin/env bash
# Pull Docker Hub images on a GitHub-hosted runner through Google's public
# mirror (findings 973 and 977; see "Docker Hub mirror" in
# docs/testing/first-agent-smoke.md).
#
#   setup   Point the runner's Docker Engine at mirror.gcr.io with debug
#           logging, and make later steps use a Docker client configuration
#           without registry sign-ins (DOCKER_CONFIG through GITHUB_ENV).
#           Run it before anything starts containers: it restarts the Engine.
#   report  Print which endpoint served each Engine pull and count the
#           Engine log lines that name a Docker Hub endpoint.
#
# The runner's built-in Docker Hub sign-in has been refused with the anonymous
# rate limit of addresses other users share, and that account's token endpoint
# has timed out. The mirror refuses any credentials, and the Engine's image
# puller forwards the client's Docker Hub sign-in to it, so the sign-in is
# removed from the client configuration. The Engine's own builder does not send
# it to the mirror, but would on a fallback to Docker Hub. Pinned digests are
# still verified, and an image the mirror lacks falls back to Docker Hub
# anonymously. Buildx builder containers pull on their own and need their own
# mirror setting.
set -euo pipefail

mirror="https://mirror.gcr.io"

setup() {
  local config=/etc/docker/daemon.json current source target client removed
  current="$(sudo cat "$config" 2>/dev/null || true)"
  [[ -n "$current" ]] || current='{}'
  jq --arg mirror "$mirror" '. + {"registry-mirrors": [$mirror], "debug": true}' <<<"$current" |
    sudo tee "$config" >/dev/null
  sudo systemctl restart docker
  timeout 60 bash -c 'until docker info >/dev/null 2>&1; do sleep 1; done'

  source="${DOCKER_CONFIG:-$HOME/.docker}"
  target="$RUNNER_TEMP/docker-config"
  mkdir -p "$target"
  client='{}'
  removed=0
  if [[ -s "$source/config.json" ]]; then
    client="$(jq 'del(.auths, .credsStore, .credHelpers)' "$source/config.json")"
    removed="$(jq '[.auths // {} | keys[]] | length' "$source/config.json")"
  fi
  printf '%s\n' "$client" >"$target/config.json"
  if [[ -d "$source/cli-plugins" && ! -e "$target/cli-plugins" ]]; then
    ln -s "$source/cli-plugins" "$target/cli-plugins"
  fi
  echo "DOCKER_CONFIG=$target" >>"$GITHUB_ENV"
  docker info --format 'registry mirrors {{json .RegistryConfig.Mirrors}}'
  echo "registry sign-ins removed from the Docker client configuration: $removed"
}

report() {
  local journal hub_pattern dns_pattern hub lookups served suppressed lines
  # An empty list below proves nothing if the storage driver changed.
  docker info --format 'driver {{.Driver}}, registry mirrors {{json .RegistryConfig.Mirrors}}'
  journal="$(sudo journalctl -u docker --no-pager -o cat || true)"
  # `docker pull` and image pulls for containers log "Trying to pull"; a
  # fallback from the mirror logs "Attempting next endpoint".
  grep -E 'Trying to pull|Attempting next endpoint|toomanyrequests' <<<"$journal" || true
  # The Engine's own builder (`docker build --builder default`) logs the
  # registry host it resolves each image on.
  grep -oE '(^| )host="?[A-Za-z0-9.:-]+' <<<"$journal" | sed 's/^ //' | sort | uniq -c || true
  hub_pattern='registry-1\.docker\.io|auth\.docker\.io|index\.docker\.io'
  # Containers on Docker networks (k3d nodes) resolve names through the
  # Engine's DNS resolver, which logs each lookup; their own image pulls do not
  # go through the Engine, so those lines are counted apart.
  dns_pattern='\[resolver\]|Name To resolve:'
  hub="$(grep -E "$hub_pattern" <<<"$journal" | grep -cvE "$dns_pattern" || true)"
  lookups="$(grep -E "$hub_pattern" <<<"$journal" | grep -cE "$dns_pattern" || true)"
  # Up to 20 of them; stderr hides the write error once the second grep stops.
  grep -E "$hub_pattern" <<<"$journal" 2>/dev/null | grep -m 20 -vE "$dns_pattern" || true
  served="$(grep -c 'mirror\.gcr\.io' <<<"$journal" || true)"
  # journald drops lines over its rate limit, which would hide Docker Hub lines.
  suppressed="$(sudo journalctl -u systemd-journald --no-pager -o cat 2>/dev/null |
    grep -c 'Suppressed.*docker\.service' || true)"
  lines="$(printf '%s' "$journal" | grep -c '' || true)"
  echo "Engine log lines: ${lines:-0}, naming mirror.gcr.io: ${served:-0}, naming a Docker Hub endpoint: ${hub:-0}"
  echo "Docker Hub lookups through the Engine's DNS resolver (container traffic, not Engine pulls): ${lookups:-0}"
  echo "journald rate-limit notices for docker.service: ${suppressed:-0}"
}

case "${1:-}" in
  setup) setup ;;
  report) report ;;
  *)
    echo "usage: $0 setup|report" >&2
    exit 2
    ;;
esac
