#!/usr/bin/env bash
# Run one native ARM smoke from the root of a checked-out OCE candidate.
set -Eeuo pipefail
umask 077

phase=preflight
stop_requested=false
owner_pid=
run_root=
stop_owner() {
  [[ -n "$owner_pid" ]] || return 0
  if ! jobs -pr | grep -Fxq "$owner_pid"; then
    wait "$owner_pid" || true
    owner_pid=
    return 1
  fi
  if [[ "$stop_requested" = false ]]; then
    stop_requested=true
    kill -TERM -- "$owner_pid" || return 1
  fi
  for ((attempt=0; attempt<100; attempt++)); do
    if ! jobs -pr | grep -Fxq "$owner_pid"; then
      local status=0
      wait "$owner_pid" || status=$?
      owner_pid=
      return "$status"
    fi
    sleep 0.2
  done
  # The VM job owns teardown after a stuck stop. Preserve this as a failure.
  return 1
}
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$owner_pid" ]] && ! stop_owner; then
    status=1
  fi
  if [[ "$status" != 0 ]]; then
    printf 'strands-box-native-ci: stopped at %s\n' "$phase" >&2
    if [[ -n "$run_root" && -f "$run_root/host.log" ]]; then
      grep -E '^strands-box-(host: startup refused (at )?[a-zA-Z0-9:_-]+|diagnostic source=[a-zA-Z0-9_-]+ stage=[a-zA-Z0-9_-]+ reason=[a-zA-Z0-9:_-]+)$' "$run_root/host.log" | head -10 >&2 || true
    fi
    if [[ -n "$run_root" && -f "$run_root/verify.log" ]]; then
      grep -E '^strands-box-verify: refused at [a-zA-Z0-9 /]+$' "$run_root/verify.log" | head -2 >&2 || true
    fi
  fi
  if [[ -n "$run_root" && -z "$owner_pid" ]]; then
    rm -rf -- "$run_root"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

expected_sha=${1:?Provide the exact checked-out source SHA}
[[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$(git rev-parse HEAD)" = "$expected_sha" ]]
[[ "$(uname -s)" = Linux && "$(uname -m)" = aarch64 && "$EUID" != 0 ]]
[[ "$(node --version)" = v24.22.1 ]]
grep -Eq '^CapEff:[[:space:]]+0+$' /proc/self/status
for tool in corepack curl file git jq realpath sha256sum tar timeout unshare; do
  command -v "$tool" >/dev/null
done
# Probe the existing runner policy without changing any host setting. This
# probes namespace creation only. The real Box run exercises mount and seccomp.
phase=runner-namespaces
if ! timeout 8s unshare --user --map-current-user --mount --pid --fork --ipc --uts --net /bin/true; then
  echo 'strands-box-native-ci: this runner refused nonroot namespace creation' >&2
  exit 1
fi

phase=artifact-verification
host_home="$(realpath -e "$HOME")"
node_bin="$(realpath -e "$(command -v node)")"
verify_shell="$(realpath -e /bin/sh)"
run_root="$(mktemp -d "$host_home/.occbox.XXXXXXXX")"
install -d -m 0700 "$run_root"/{box,codex,agent,run,workspace,held}
box_archive_sha=9060a4ccca1d6d5153da31e9214d3fd64c9bab0aa7762b6556d2790a8a0f06c0
codex_archive_sha=048a62731ce28aa000508efcc032302e58488ca079970dcae06d28df39ae5ce0
codex_sha=8813c8d8a4cea2eeba271b72ab22f49628b184b24ab18dbef06b4ce41e9a8d39
curl --proto '=https' --fail --location --silent --show-error --max-time 90 \
  https://github.com/strands-agents/box/releases/download/v0.2.1/box-v0.2.1-linux-arm64.tar.gz \
  --output "$run_root/box.tgz"
curl --proto '=https' --fail --location --silent --show-error --max-time 120 \
  https://registry.npmjs.org/@openai/codex/-/codex-0.164.0-linux-arm64.tgz \
  --output "$run_root/codex.tgz"
printf '%s  %s\n' "$box_archive_sha" "$run_root/box.tgz" "$codex_archive_sha" "$run_root/codex.tgz" \
  | sha256sum --check --strict --status
tar --extract --gzip --file "$run_root/box.tgz" --directory "$run_root/box" --no-same-owner \
  ./box ./strands-box-contain-trampoline ./strands-box-sock-alias
codex_bin="$run_root/codex/codex"
tar --extract --to-stdout --gzip --file "$run_root/codex.tgz" \
  package/vendor/aarch64-unknown-linux-musl/bin/codex > "$codex_bin"
printf '%s  %s\n' "$codex_sha" "$codex_bin" | sha256sum --check --strict --status
chmod 0700 "$codex_bin"
for bin in "$run_root"/box/{box,strands-box-contain-trampoline,strands-box-sock-alias} "$codex_bin"; do
  [[ -f "$bin" && -x "$bin" && ! -L "$bin" ]]
  file -b "$bin" | grep -q 'ARM aarch64'
done
sanitized=(env -i "HOME=$host_home" "PATH=$(dirname "$node_bin"):/usr/bin:/bin" "LANG=C.UTF-8")
"${sanitized[@]}" "$run_root/box/box" --version | grep -Fx 'strands-box 0.2.1'
install -d -m 0700 "$run_root/version-home"
[[ "$("${sanitized[@]}" "CODEX_HOME=$run_root/version-home" "$codex_bin" --version)" = 'codex-cli 0.164.0' ]]

phase=checkout-dependencies
timeout --kill-after=5s 180s corepack pnpm install --frozen-lockfile --ignore-scripts
phase=host-compile
timeout --kill-after=5s 120s corepack pnpm exec tsc -p deploy/examples/strands-box/host/tsconfig.agent.json \
  --outDir "$run_root/agent"
config="$run_root/smoke.json"
jq -n --arg root "$run_root" --arg node "$node_bin" --arg shell "$verify_shell" '{
  linuxPreview: true,
  boxBin: ($root + "/box/box"),
  nodeBin: $node,
  codexBin: ($root + "/codex/codex"),
  agentBuildDir: ($root + "/agent"),
  runtimeDir: ($root + "/run"),
  workspace: ($root + "/workspace"),
  read: [], exec: [$shell]
}' > "$config"
printf 'strands-box-held\n' > "$run_root/held/probe"

phase=host-start
"${sanitized[@]}" "$node_bin" deploy/examples/strands-box/host/launch.ts "$config" \
  > "$run_root/host.log" 2>&1 &
owner_pid=$!
ready=false
for ((attempt=0; attempt<225; attempt++)); do
  jobs -pr | grep -Fxq "$owner_pid" || exit 1
  if grep -Fxq 'strands-box-host: ready' "$run_root/host.log"; then
    ready=true
    break
  fi
  sleep 0.2
done
[[ "$ready" = true ]]

phase=native-verification
timeout --kill-after=3s 45s "${sanitized[@]}" "$node_bin" deploy/examples/strands-box/verify-native.ts \
  "$config" "$verify_shell" "$run_root/held/probe" > "$run_root/verify.log" 2>&1
grep -Eq '^strands-box-verify: verified marker=strands-box-verify-[a-f0-9]{24}\.txt outside=verified$' \
  "$run_root/verify.log"

phase=cleanup
stop_owner
for control in ready.json capability app-server.sock pinned.sock; do
  [[ ! -e "$run_root/run/$control" && ! -L "$run_root/run/$control" ]]
done
[[ ! -e "$run_root/run-home" && ! -L "$run_root/run-home" ]]
printf 'strands-box-native-ci: PASS source=%s kernel=%s arch=aarch64 box=0.2.1 codex=0.164.0 scope=standalone\n' \
  "$expected_sha" "$(uname -r)"
