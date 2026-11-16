# Run one dedicated Codex Agent in Strands Box

Verify native startup on a dedicated Linux ARM64 host, then deploy an Agent
through the ordinary OpenClaw Enterprise (OCE) workflow. The example Driver
refuses protected repository delivery. Leave it disabled on that path. The
[fixed-repository sender](git/README.md) has component tests against controlled
origins. It has yet to be verified on an installed Box Agent. Protected GitHub acceptance requires a separate paired Driver and sender.

The [Worker integration test](../../../tests/integration/strands-box-deployment.test.ts)
deploys an Agent through the API and checks the original request at the Driver.
It stops at a held host response. The [Git sender tests](../../../tests/conformance/strands-box-git.test.ts)
use a local Git server. These checks do not establish an installed Box chat
or a pull request on GitHub.

## Prepare the host and verify Box

Use a dedicated Linux ARM64 host, such as a Graviton EC2 instance, with a nonroot
operator account and private connectivity to the installation. Use the
repository's [Node.js version](../../../package.json) and Codex from the matching
[OCE runtime build](../../runtime/README.md).

From a new directory on the host, download the
[Strands Box v0.2.2 Linux ARM64 release](https://github.com/strands-agents/box/releases/tag/v0.2.2).
Verify the archive before extracting it. Keep Box and both helpers together.
The Box release and the OCE Driver package have independent version numbers.

```bash
curl --fail --location --remote-name \
  https://github.com/strands-agents/box/releases/download/v0.2.2/box-v0.2.2-linux-arm64.tar.gz &&
printf '%s  %s\n' \
  '7d77f8e261c5c6f4e37c74d77219e9ebb47725f3ced4c29e752c3f51abb789cc' \
  'box-v0.2.2-linux-arm64.tar.gz' | sha256sum --check --strict &&
tar -xzf box-v0.2.2-linux-arm64.tar.gz
```

From the OCE checkout, use the workspace toolchain to build the host helper.
Set `AGENT_BUILD_DIR` to an absolute path outside the runtime and workspace
directories. Keep `box-agent.js`, `transport.js` and `diagnostics.js` together in that directory.

```bash
pnpm exec tsc -p deploy/examples/strands-box/host/tsconfig.agent.json \
  --outDir "$AGENT_BUILD_DIR"
```

### Terminal 1. Start the native app-server inside Box

Run both terminals as the same nonroot operator. Create a short, canonical
mode `0700` parent owned by that operator. The launcher needs write access to
the parent to create its own temporary sibling directory. Avoid using `/run`
itself as the parent.

```bash
BOX_VERIFY_ROOT=$(mktemp -d "$(realpath -e "$HOME")/oce-box-native.XXXXXX")
install -d -m 0700 "$BOX_VERIFY_ROOT/run" "$BOX_VERIFY_ROOT/workspace"
BOX_VERIFY_SHELL=$(realpath -e /bin/sh)
```

Copy the [smoke configuration](host/smoke.example.json) to a mode `0600` JSON
file owned by the operator. Replace the paths with canonical absolute paths.
Use `$BOX_VERIFY_ROOT/run` for `runtimeDir` and `$BOX_VERIFY_ROOT/workspace` for
`workspace`. Add the exact value of `BOX_VERIFY_SHELL` to the `exec` array.
Keep the parent, runtime directory and credentials out of `read` and `exec`.
Set `BOX_SMOKE_CONFIG` to the absolute path of the JSON file, then run the
[host smoke entry point](host/launch.ts) from the checkout root.

```bash
node deploy/examples/strands-box/host/launch.ts "$BOX_SMOKE_CONFIG"
```

Wait for `strands-box-host: ready`. Keep this terminal running.

### Terminal 2. Verify the native workspace command

Use the same checkout and its frozen pnpm dependencies. Set `BOX_SMOKE_CONFIG`
and `BOX_VERIFY_SHELL` to the same paths as in terminal 1. To check isolation
from a sibling directory, create this disposable control outside the workspace.
Set `BOX_VERIFY_ROOT` to the parent directory from terminal 1.

```bash
install -d -m 0700 "$BOX_VERIFY_ROOT/held"
BOX_HELD_FILE="$BOX_VERIFY_ROOT/held/probe"
(umask 077; set -C; printf 'strands-box-held\n' > "$BOX_HELD_FILE")
```

Run the [verifier](verify-native.ts). Omit the final argument if you did not
create the held file.

```bash
node deploy/examples/strands-box/verify-native.ts \
  "$BOX_SMOKE_CONFIG" "$BOX_VERIFY_SHELL" "$BOX_HELD_FILE"
```

The verifier expects HTTP 401 without a bearer and with a wrong bearer, then
initializes Codex with the original launcher's private capability. It runs one
`command/exec` inside Box with external sandboxing and restricted networking.
A separate native `fs/readFile` must return the fresh workspace marker. If you
supplied the held file, native reads and writes must be refused and its host
bytes must stay unchanged. Success prints the workspace filename and
`outside=verified` or `outside=not-requested`. The capability and file contents
stay out of the output. Stop terminal 1 with Ctrl-C when finished. This check
does not exercise an OCE Agent turn, workspace-node enrollment or GitHub.

The [optional Shell Calls workspace verifier](workspace-verifier/README.md)
exercises one narrowly permitted read through the Box broker. It is a separate
check from the native startup verifier above. The [ordinary chat reproduction](ordinary-chat/README.md)
joins that declared tool to one authenticated Gateway turn using a local synthetic model.

## Connect the installation

For the file-only workspace node, follow the [installed ordinary chat and workspace procedure](ordinary-chat/installed.md)
in order: verify an empty control export with the Worker stopped; mount it
read-only in one Worker and deploy the stopped Agent once; then use the
Worker's original workspace claim to start the held host and verify the
live socket before approval. The host cannot start before that claim exists.

Box v0.2.2's HTTP egress proxy
[refuses protocol upgrades](https://github.com/strands-agents/box/blob/d9346bf0d281153ea7dc6338ad1f0b7e122be687/crates/egress-gateway/src/intercept/mitm/http1.rs#L277-L285),
so the file node has a separate route to the Agent Gateway. The Box Harness
still connects to the Gateway over the installed relay.

## Verify ordinary chat and protected prerequisites

Use the approved model connection. In the same ordinary chat, read a fresh
workspace marker whose contents are absent from the prompt. Try to read and
write a same-owner sibling file from the same Box execution. Verify both
refusals and confirm the sibling's bytes stayed unchanged.

The Driver refuses protected repository delivery. Full GitHub verification
requires a paired Sandbox and Credential Proxy Driver, an admitted issuer,
and an execution-bound route to the authenticated sender. The pinned stock Box
proxy terminates workload TLS. A Git client certificate configured inside Box
does not authenticate the separate connection to the sender.
Use the [sender rehearsal](../../../docs/testing/strands-box.md) for controlled
Git and draft checks and the [installed custody acceptance procedure](../../../docs/testing/protected-repository-custody.md#qualify-installed-custody)
once a compatible supplier is available.
