# SSH host tests

## Overview

Verify the SSH Compute Driver against a disposable Linux host with real
OpenClaw and systemd. The default real-host run checks readiness only; the model selector below adds provider execution.

## Local conformance and startup

Run these checks without a disposable host:

```sh
node --test tests/conformance/ssh-compute.test.mjs
node --test tests/integration/ssh-compute-startup.test.mjs
```

They execute the actual helper with transport, account-management, and systemd
fixtures. See [local conformance boundaries](local.md#local-checks) for what those
fixtures cover. Use the real-host suite below to verify SSH, systemd, and OS
account isolation on the selected disposable host.

## SSH raw hosts

The `checks-baseline-*` CI lanes run SSH conformance and startup coverage. The
`ssh-host` lane selects the real-host test with required operator-provided SSH
settings. It is not part of the `ci` or `full` groups because those jobs do not
provision an SSH host.
Prepare the disposable rig below before selecting this lane; missing inputs or
skipped tests fail the lane.

Use a disposable Linux systemd host. This suite verifies readiness, version
cutover, state persistence, cleanup, and Unix account isolation over real SSH.
It makes no model call. Without `OCC_TEST_SSH_REAL=1` it skips; a selected run
fails when prerequisites are missing.

The fixture image builds on the runtime image's `docker.io/library/node:24-bookworm` base and
adds systemd as PID 1, sshd, an `openclaw` system user, and the pinned
OpenClaw/Codex assembly from
[`deploy/runtime/Dockerfile`](../../deploy/runtime/Dockerfile), including the same
workspace templates as the Console. Build that runtime image first; it builds on amd64
and arm64. Start it on a Docker Engine with privileged systemd/cgroup support
(Docker Desktop on Apple silicon works). This privileged container is a
disposable test rig, not production packaging. If the Engine cannot run
systemd, use an explicitly selected disposable Linux VM instead; do not
substitute the conformance fixture and call it host proof.
Make sure `oce-ssh-host` is not an existing container before starting the rig.
In the same Bash shell, [resolve the OpenClaw build arguments](../../deploy/runtime/README.md#resolve-openclaw-build-arguments)
before building the runtime image:

```bash
SSH_RIG=$(mktemp -d)
chmod 700 "$SSH_RIG"
ssh-keygen -q -t ed25519 -N '' -f "$SSH_RIG/id_ed25519"
docker build -f deploy/runtime/Dockerfile "${openclaw_build_args[@]}" \
  -t localhost/openclaw-runtime:local .
docker build --build-arg RUNTIME_IMAGE=localhost/openclaw-runtime:local \
  -t oce-ssh-host:local tests/fixtures/ssh-compute/host
docker run -d --name oce-ssh-host --privileged --cgroupns=host \
  --tmpfs /run --tmpfs /run/lock \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --mount "type=bind,src=$SSH_RIG/id_ed25519.pub,dst=/run/occ-authorized_keys,readonly" \
  -p 127.0.0.1:22222:22 oce-ssh-host:local
docker exec oce-ssh-host install -o root -g root -m 600 \
  /run/occ-authorized_keys /root/.ssh/authorized_keys
docker exec oce-ssh-host systemctl is-active ssh
docker exec oce-ssh-host cat /etc/ssh/ssh_host_ed25519_key.pub \
  | awk '{ print "[127.0.0.1]:22222 " $1 " " $2 }' > "$SSH_RIG/known_hosts"
chmod 600 "$SSH_RIG/known_hosts"
```

Wait for `systemctl is-active ssh` to report `active`. The known-host entry
comes from this disposable container; host-key verification remains enabled.

```sh
OCC_TEST_SSH_REAL=1 \
OCC_TEST_SSH_ADDRESS=127.0.0.1 \
OCC_TEST_SSH_PORT=22222 \
OCC_TEST_SSH_USER=root \
OCC_TEST_SSH_IDENTITY_FILE="$SSH_RIG/id_ed25519" \
OCC_TEST_SSH_KNOWN_HOSTS_FILE="$SSH_RIG/known_hosts" \
OCC_TEST_SSH_NODE_PATH=/usr/local/bin/node \
OCC_TEST_SSH_OPENCLAW_PATH=/opt/openclaw/current/dist/index.js \
OCC_TEST_SSH_RUNTIME_USER=openclaw \
OCC_TEST_SSH_ROOT=/var/lib/openclaw-enterprise \
OCC_TEST_SSH_UNIT_DIRECTORY=/etc/systemd/system \
node --test tests/integration/ssh-compute-real.test.mjs
```

The host must have ports `18800`–`18899` available. The suite creates unique
Namespace and Agent identities and removes only its own Namespace and units.
An unselected skip or a fixture pass is not real-host proof.

After testing, remove only the rig and its generated keys:

```sh
docker rm -f oce-ssh-host
rm -r "$SSH_RIG"
```

Inspect the Agent's exact unit with `journalctl -u` inside the container when
readiness fails; keep logs free of credential values.

## Runtime credential model proof

With the disposable SSH host inputs above, also set `OCC_TEST_SSH_MODEL=1`,
`OCC_TEST_OPENAI_API_KEY_FILE` to a protected local file containing an authorized
OpenAI API key, and optionally `OCC_TEST_OPENAI_MODEL` (default `gpt-6-astra`). Run the
same `tests/integration/ssh-compute-real.test.mjs` file. This selector requires
the SSH inputs and fails if the host or credential is unavailable; it never
substitutes the local systemd fixture.

This checks a real provider request and runtime credential handling. It does
not prove API admission or a whole-controller rollout. Cleanup removes only the
test Namespace and forwarder.

## SSH real-host test environment

The command above supplies the required SSH address, port, root user, private
key, verified known-hosts file, Node path, OpenClaw path, and runtime account
prefix. `OCC_TEST_SSH_ROOT` and `OCC_TEST_SSH_UNIT_DIRECTORY` select the state
root and systemd directory. Run again with an owned directory outside systemd's
unit load path when checking that configuration. Inspect the exact unit with
`journalctl -u` for readiness failures; do not expose credentials in logs.
