# Run one dedicated Codex Agent in Strands Box

Verify native startup on a dedicated Linux ARM64 host, then deploy an Agent
through the ordinary OpenClaw Enterprise (OCE) workflow. The example Driver
refuses protected repository delivery. Leave it disabled on that path. The
[fixed-repository sender](git/README.md) has component tests against controlled
origins. It has yet to be verified on an installed Box Agent. The GitHub steps
below are acceptance checks for a paired Driver and sender on the same execution.

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
[Strands Box v0.2.1 Linux ARM64 release](https://github.com/strands-agents/box/releases/tag/v0.2.1).
Verify the archive before extracting it. Keep Box and both helpers together.

```bash
curl --fail --location --remote-name \
  https://github.com/strands-agents/box/releases/download/v0.2.1/box-v0.2.1-linux-arm64.tar.gz &&
printf '%s  %s\n' \
  '9060a4ccca1d6d5153da31e9214d3fd64c9bab0aa7762b6556d2790a8a0f06c0' \
  'box-v0.2.1-linux-arm64.tar.gz' | sha256sum --check --strict &&
tar -xzf box-v0.2.1-linux-arm64.tar.gz
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

**Enrollment gate:** Box v0.2.1's HTTP egress proxy
[refuses protocol upgrades](https://github.com/strands-agents/box/blob/e39544d49188b82933264b83159c7ccc278ced5a/crates/egress-gateway/src/intercept/mitm/http1.rs#L271-L289).
The outbound workspace-node WebSocket cannot use that proxy. Continue only if
the installation has a supported, verified route for the original node. The
inbound Harness route below is separate. The controlled inference fixture also
needs a certificate trusted by Box's upstream client. The Box CLI
[does not accept a custom upstream CA](https://github.com/strands-agents/box/blob/e39544d49188b82933264b83159c7ccc278ced5a/crates/box/tests/box_credentials.rs#L480-L490).

Start with the [production installation guide](../../../docs/guides/deploy/production-installation.md)
for the control plane. Review the [example Driver](driver/README.md#build-and-select),
then follow its build, package and Installation steps. The Driver runs with the
controller's authority. Use the same package and configuration on API and Worker.

1. Follow [Connect one Agent Gateway to the Box host](ingress/README.md) to
   allocate the Service, configure `network.providerHarness`, and prepare the
   relay and ingress. Keep the TLS private key with the ingress owner. The
   workspace node needs a separate route back to the original Gateway.
2. Create one dedicated Codex Agent using the normal
   [Agent workflow](../../../docs/guides/deploy/production-agents.md#configure-the-agent-runtime).
   Use the [controlled inference configuration](driver/README.md#build-and-select)
   for this example. Keep real model credentials out of Box.
   Copy the [installed configuration](host/installed.example.json) and replace
   the example values with the actual Driver, Namespace and Agent identities,
   image digest, staged workspace claim and endpoint. For each staged mount,
   record its device and inode with `stat -c '%d %i'`. Set the workspace node's
   Gateway WSS URL and private IPv4 address. Configure a controlled inference
   route only for the installation's test fixture. Use a new mode `0700`
   `approvalDir` outside both the Worker's socket mount and Box's file grants.
3. Give only the Worker access to the owner-only Unix control socket. Set
   `BOX_INSTALLED_CONFIG` to the absolute path to the mode `0600` installed
   configuration. Run the
   [host control entry point](host/control.ts) as the same nonroot owner.

   ```bash
   node deploy/examples/strands-box/host/control.ts "$BOX_INSTALLED_CONFIG"
   ```

   `strands-box-control: ready` means the control socket is listening. Deploy
   the Agent once. The host writes `runtimeDir/pending.json` before the Worker
   reads the workspace setup Secret. Compare the pending owner, revision and
   requirements with the original deployment through OCE. Set `BOX_REVISION_ID`
   and `BOX_REQUIREMENTS_DIGEST` to the reviewed values. Approve that request
   from the Box host.

   ```bash
   node deploy/examples/strands-box/host/control.ts approve "$BOX_INSTALLED_CONFIG" \
     "$BOX_REVISION_ID" "$BOX_REQUIREMENTS_DIGEST"
   ```

   The Worker continues the same deployment on its next reconciliation. Use
   that execution's `ready.json` for ingress. A relay probe verifies that the
   original listener rejects an anonymous upgrade. The Driver separately
   requires an authenticated Codex `initialize` result for the same execution.
   Verify workspace node enrollment before chat.

## Verify chat and repository access

Use the approved model connection. Ask the Agent in its ordinary chat to read a
fresh workspace file whose contents are absent from the prompt. Verify the marker
in that same chat.
From the same Box execution, attempt to read and write a same-owner sibling file
outside the workspace. Both attempts must fail and the file must stay unchanged.

For the protected check, use a GitHub test repository you control. The App
needs **Contents: read and write**, **Pull requests: read and write**, and
**Metadata: read**. Give the Agent a finite assignment to just that repository
before deploying the version under test. Repeat the chat and isolation checks
on that execution, then run the GitHub checks below. See
[repository access levels](../../../docs/reference/repository-credentials/access-levels.md)
and [protected sender selection](../../../docs/reference/drivers/selection.md#select-a-protected-sender).
The issuer keeps the App signing key. The trusted sender uses the installation
token outside Box. Keep both and any host Git credentials out of the Agent's
environment, files and prompts.

1. In the original chat, ask the Agent to change one file and use Git to push
   one commit through the [configured remote](git/README.md#use-the-admitted-remote).
   In the same chat, have the Agent send `POST /draft-pull` with the sender's
   [draft command](git/README.md#use-the-admitted-remote).

   ```sh
   curl --cacert "$SENDER_CA" --cert "$EXECUTION_CERT" --key "$EXECUTION_KEY" \
     --header 'Content-Type: application/json' --data '{"title":"Review change"}' \
     https://repository-sender.example.invalid/draft-pull
   ```

   Use the configured sender hostname and the execution's certificate files.
   Independently verify the file, branch, commit and draft head on GitHub. The
   example PR action uses its configured head and base. GitHub's token
   permissions and repository rules govern provider access.

2. Try a different repository path against the controlled sender. Verify that
   it refuses the request before contacting the origin and leaves the attempted
   ref unchanged.
3. Withdraw the active Agent's repository assignment through OCE without
   stopping the Agent. From that same execution, attempt a fresh authenticated
   fetch and a fresh push. Verify that the sender refuses both before contacting
   GitHub and that the attempted ref stays unchanged. Send an ordinary message
   and verify that the same chat still replies. Withdrawal leaves any shared
   installation token unchanged. Removing a repository from a saved draft does
   not by itself prove withdrawal from the running Agent.

Keep the observed host, chat and GitHub results separate. If a push or PR
request loses its response, check the original ref or PR before retrying. When
finished, stop the test Agent through OCE and verify retirement of its Box
execution and private route.
