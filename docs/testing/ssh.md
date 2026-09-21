# SSH host tests

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

The `checks-baseline` CI lane runs SSH conformance and startup coverage. The
`ssh-host` lane selects the real-host test with required operator-provided SSH
settings. It is not part of the `ci` or `full` groups because those jobs do not
provision an SSH host.
Prepare the disposable rig below before selecting this lane; missing inputs or
skipped tests fail the lane.

The bundled [SSH Compute Driver](../reference/drivers/ssh-compute.md) has an opt-in
real-host integration. Use a disposable Linux systemd host only. The test
checks gateway readiness, two-revision cutover, state persistence, retirement,
and Namespace deletion over real SSH. It also checks distinct Agent UID/GID
assignments and sibling state/configuration read denial using Linux `runuser`. It makes no model call and needs no
model credential. The ordinary local test command reports an explicit skip:

```sh
node --test tests/integration/ssh-compute-real.test.mjs
```

The fixture image builds on the runtime image's `docker.io/library/node:24-bookworm` base and
adds systemd as PID 1, sshd, an `openclaw` system user, and the pinned
OpenClaw/Codex packages from
[`deploy/runtime/Dockerfile`](../../deploy/runtime/Dockerfile); it builds on amd64
and arm64. Start it on a Docker Engine with privileged systemd/cgroup support
(Docker Desktop on Apple silicon works). This privileged container is a
disposable test rig, not production packaging. If the Engine cannot run
systemd, use an explicitly selected disposable Linux VM instead; do not
substitute the conformance fixture and call it host proof.

```sh
SSH_RIG=$(mktemp -d)
chmod 700 "$SSH_RIG"
ssh-keygen -q -t ed25519 -N '' -f "$SSH_RIG/id_ed25519"
docker build -t oce-ssh-host:local tests/fixtures/ssh-compute/host
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

The read-only `/run/occ-authorized_keys` mount is the fixture's public-key
input; copying it gives sshd's `/root/.ssh/authorized_keys` the required root
ownership and mode. Root login permits keys only (`PermitRootLogin
prohibit-password`). The known-host entry above comes directly from this
task-owned container, without disabling strict host-key verification. Wait for
`systemctl is-active ssh` to report `active` before selecting the suite.

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

The gateway port range is `18800`–`18899`; it is checked on the host through
SSH and does not need a published container port. The suite creates unique
Namespace and Agent identities and removes only its Namespace and units. When
selected, missing settings, unreachable SSH, failed systemd, or unready OpenClaw
fail the test. Successful local conformance or an unselected skip does not
establish real-host proof; rerun this suite after changing the Driver, helper,
or fixture.

After testing, remove only the rig and its generated keys:

```sh
docker rm -f oce-ssh-host
rm -r "$SSH_RIG"
```

See [SSH test settings](#ssh-real-host-test-environment)
for every input and default. Inspect the Agent's exact unit with `journalctl -u`
inside the container when readiness fails; keep logs free of credential values.

## Runtime credential model proof

With the disposable SSH host inputs above, also set `OCC_TEST_SSH_MODEL=1`,
`OCC_TEST_OPENAI_API_KEY_FILE` to a protected local file containing an authorized
OpenAI API key, and optionally `OCC_TEST_OPENAI_MODEL` (default `gpt-6-astra`). Run the
same `tests/integration/ssh-compute-real.test.mjs` file. This selector requires
the SSH inputs and fails if the host or credential is unavailable; it never
substitutes the local systemd fixture.

The test checks the key/model against the provider first, then provisions the
host's protected `<agentDir>/env` as an operator via SSH stdin. It deploys with
`{ "method": "runtime" }`, verifies readiness and a real model turn, and counts
provider requests through a loopback forwarding server. Startup and readiness
must make zero model requests. After replacing the key with a synthetic invalid
one and restarting the existing revision, readiness must still succeed while a
real model request fails. Redeployment, retirement, and stop must preserve the
operator file's bytes, mode, inode, and modification time. Cleanup stops the
forwarder and deletes only the test Namespace.

This test exercises the real SSH Driver/helper, systemd, OpenClaw, and provider;
API admission, immutable PostgreSQL snapshots, and worker reauthorization have
separate integration coverage. It is not a whole-controller production rollout.

## SSH real-host test environment

`node --test tests/integration/ssh-compute-real.test.mjs` is selected only by
`OCC_TEST_SSH_REAL=1` or `OCC_TEST_SSH_MODEL=1`. Otherwise it explicitly skips and lists its inputs. When
selected, missing inputs or unavailable hosts fail; there is no fixture fallback.

| Variable                        | Meaning                                                                 |
| ------------------------------- | ----------------------------------------------------------------------- |
| `OCC_TEST_SSH_REAL`             | Set to `1` for a disposable Linux systemd/sshd host with real OpenClaw. |
| `OCC_TEST_SSH_ADDRESS`          | Required host address.                                                  |
| `OCC_TEST_SSH_PORT`             | Required SSH port, `1`–`65535`.                                         |
| `OCC_TEST_SSH_USER`             | Required; currently `root`.                                             |
| `OCC_TEST_SSH_IDENTITY_FILE`    | Required absolute private-key path on the test worker.                  |
| `OCC_TEST_SSH_KNOWN_HOSTS_FILE` | Required absolute verified known-hosts path on the test worker.         |
| `OCC_TEST_SSH_NODE_PATH`        | Required absolute Node.js 24 executable path on the host.               |
| `OCC_TEST_SSH_OPENCLAW_PATH`    | Required absolute OpenClaw entrypoint path on the host.                 |
| `OCC_TEST_SSH_RUNTIME_USER`     | Required prefix for Driver-managed per-Agent Unix accounts.             |
| `OCC_TEST_SSH_ROOT`             | Optional host state root, default `/var/lib/openclaw-enterprise`.       |
| `OCC_TEST_SSH_UNIT_DIRECTORY`   | Optional host unit directory, default `/etc/systemd/system`.            |

The suite uses ports `18800`–`18899`, creates unique Namespace/Agent identities,
verifies readiness through SSH, cuts over two revisions, checks private Agent
UID/GID isolation and state persistence, retires the first snapshot, and deletes its Namespace.
The readiness-only selector requires no model credential and proves no model turn;
the model selector adds the credential proof above. Use the
[container rig](#ssh-raw-hosts) or a disposable host of your own.

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).
