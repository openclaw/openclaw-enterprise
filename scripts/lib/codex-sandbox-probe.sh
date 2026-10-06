#!/bin/sh
set -eu
expected_version=$1
nonce=$2
stage=VERSION

# Bind evidence to this invocation of the trusted command, not client error text.
finish_probe() {
  result=$?
  trap - EXIT
  printf 'OCE_SANDBOX_PROBE_V1:%s:END:%s:%s\n' "$nonce" "$stage" "$result" >&2
  exit "$result"
}

verify_version() {
  version=$(codex --version | awk '{print $NF}')
  if [ "$version" != "$expected_version" ]; then
    echo "Codex version mismatch: expected $expected_version, got $version" >&2
    exit 64
  fi
}

prepare_workspace() {
  mkdir -p /home/node/.codex /workspace
  cd /workspace
  outside=/home/node/codex-seccomp-outside
  rm -f "$outside" /workspace/codex-seccomp-ok
  echo outside-ok > "$outside"
}

probe_workspace_boundary() {
  timeout 60s codex sandbox \
    -c sandbox_mode="workspace-write" \
    -c sandbox_workspace_write.network_access=false \
    -- sh -c '
      set -eu
      printf "OCE_SANDBOX_PROBE_V1:%s:ENTERED\n" "$1" >&2
      echo ok > /workspace/codex-seccomp-ok
      if echo escaped > /home/node/codex-seccomp-outside; then
        echo outside workspace write unexpectedly succeeded >&2
        exit 70
      fi
    ' codex-sandbox-boundary "$nonce"
}

assert_workspace_boundary() {
  test "$(cat /workspace/codex-seccomp-ok)" = ok
  test "$(cat "$outside")" = outside-ok
}

cleanup_workspace() {
  rm -f "$outside" /workspace/codex-seccomp-ok
}

trap finish_probe EXIT
printf 'OCE_SANDBOX_PROBE_V1:%s:START\n' "$nonce" >&2
verify_version
stage=PREPARE
prepare_workspace
stage=SANDBOX
probe_workspace_boundary
stage=ASSERTIONS
assert_workspace_boundary
stage=CLEANUP
cleanup_workspace
stage=DONE
