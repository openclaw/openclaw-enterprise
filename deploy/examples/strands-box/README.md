# Run one dedicated Codex Agent in Strands Box

Verify native startup on a dedicated Linux ARM64 host, then deploy an Agent
through the ordinary OpenClaw Enterprise (OCE) workflow. By default the example
Driver refuses protected repository delivery. Configuring `protectedRepository`
selects the [paired protected registration](driver/README.md#paired-protected-registration)
instead: the same package then supplies the protected Sandbox Driver and its
Credential Proxy. Box injects GitHub credentials on its own `github.com` and
`api.github.com` routes and asks OCE for each request through the Worker, so
the Agent uses [stock `git` and `gh`](git/README.md). This stage needs a Box
build with the request-time credential source, and OCE applies no draft rule to
`gh`'s API requests. See the
[known gaps](KNOWN-GAPS.md#github-access-needs-the-box-forks-request-time-credential-source).
The pairing has component tests against controlled origins. It has yet to be
verified on an installed Box Agent. The GitHub steps below are acceptance
checks for that pairing on one execution.

The [Worker integration test](../../../tests/integration/strands-box-deployment.test.ts)
deploys an Agent through the API and checks the original request at the Driver.
It stops at a held host response. The [paired Driver end-to-end test](../../../tests/conformance/strands-box-protected-gh.test.ts)
runs stock `git` and `gh` against a controlled GitHub origin through a stand-in
for Box egress. These checks do not establish an installed Box chat or a pull
request on GitHub.

Read the [known gaps](KNOWN-GAPS.md) before deploying.

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

### Select a prepared Harness image for an installed host

An installed control host can opt in by setting `harnessImageReceipt` to the
absolute path of the original operator's root-owned, read-only JSON receipt.
Use this profile only on a dedicated Linux ARM64 carrier running as UID/GID 1000. Prepare the active read-only root of that carrier from the exact approved
OCI image. Verify its manifest, config, layers, and materialized files before
issuing the receipt. Keep that root and its mount in place through retirement.
The installed host uses the stock Box process to launch the workload from the
canonical paths in that view.

The receipt binds the selected image to the current boot and launch command.

| Field                       | Value                                                                                                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`                      | `dedicated-read-only-root-v3`                                                                                                                                                                       |
| `image`                     | The full installed image reference including the exact manifest digest                                                                                                                              |
| `bootId`, `mountId`, `root` | The current Linux boot ID, mount ID of `/`, and its decimal-string `dev` and `ino`                                                                                                                  |
| `proc`                      | The original kernel procfs mount's decimal-string `mountId`, `dev`, and `ino` in the Host's namespace                                                                                               |
| `commandSha256`             | SHA-256 of the JSON array of the producer's actual standalone Harness argv, after any separately approved file-node split                                                                           |
| `files`                     | The SHA-256 of each image file under keys `node`, `codex`, `tini`, and `openclaw`, for `/usr/local/bin/node`, `/opt/oce/runtime/codex/codex`, `/usr/bin/tini`, and `/app/openclaw.mjs` respectively |

Issue the receipt from the same boot and mount view that will start the
control server. Place it under root-owned directories that the operator account
cannot modify. Keep the released Box and its helpers outside the image
runtime paths granted to the workload. The supported carrier uses the pinned
ARM64 Box v0.2.2 binaries and their pinned Debian loader and libraries. Keep
`/tmp` on a separate writable filesystem for Box's mount setup, and supply the
existing private owner state, workspace mounts, and separate file-node root
through the normal installation procedure. Mounts must leave the image
runtime paths and their backing filesystem read-only for the installed host.

In the receipt's `files` map, also pin the compiled agent's `box-agent.js`,
`transport.js`, and `diagnostics.js` as `agentEntry`, `agentTransport`, and
`agentDiagnostics`. Pin the static ARM64 `harness-proc` verifier as
`procVerifier` and install it beside the compiled agent. Keep the released Box directory and the compiled agent
directory in root-owned, read-only locations. They can share the prepared
carrier root or use separately prepared read-only mounts. The Host refuses
mount changes or overlays inside these directories. Just before starting Box,
it rechecks the original file identities and hashes and the approved split
file. A separate file node waits until Box has passed that check and started.

The original operator must establish the carrier's boot and PID 1 custody
before issuing the receipt. Use the original kernel procfs mounted for the
Host's PID and mount namespaces. Keep it in place through retirement, with no
binds over the Host's mount inventory, the procfs `self` path, or the boot ID.
Build the fixed verifier from `deploy/examples/strands-box/harness-proc` with
`CGO_ENABLED=0` for Linux ARM64. In a shell in the same trusted namespace,
run the verified binary with its file descriptor 3 opened on `/proc`
(`harness-proc 3</proc`). Use its `proc` and `bootId` fields and keep the
mount inventory private. The Host holds its original procfs descriptor and
checks the active mount against it. The kernel must support `openat2` for
the verifier to read the exact files without crossing another mount. The
verifier opens the files itself inside that namespace. The original boot
and PID 1 custody still come from the operator.

For a separate file node, commit to the exact combined-to-standalone command
pair before accepting a Worker admission. This profile recognizes only the pair
that the Compute in this checkout renders. `host/installed-harness-image.ts`
pins both digests, and `tests/conformance/strands-box-harness-image.test.ts`
fails when Compute changes either program, so a Compute change needs a reviewed
re-pin. In this checkout, generate the standalone argv:

```ts
[...RUNTIME_WRAPPER_COMMAND, ...nodeProgramArguments(PROVIDER_CODEX_ONLY_PROGRAM)];
```

Put the JSON array in root-owned, read-only `harness-split-argv.json` beside the
built agent. Pin that array's digest in the receipt. The Worker still sends and
authorizes the original combined command. The installed host checks the exact
combined program and selects the matching standalone program only after the
separate file node inputs have passed admission.

The installed host accepts Compute's stock `PATH`. The image must supply a
symlink at `/app/node_modules/.bin/codex` to its native binary at
`/opt/oce/runtime/codex/codex`. Box's existing read grant for `/app` carries the
symlink, and its existing executable grant carries the target. The image must
leave the directories before `/usr/local/bin` free of alternate Node binaries.

```text
/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
```

The installed host checks the selected mount, runtime files, executed argv,
and admitted `PATH`. A writable root, a different standalone command, or a
substituted executable is refused before Box and the file node are started.
The existing profile applies when the receipt setting is absent.

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
The Worker keeps the App signing key; OCE mints the installation token and
returns it for one request at a time. The Box host passes each value to Box
once and keeps none. Keep the App key, the token and any host Git credentials
out of the Agent's environment, files and prompts.

The Box host starts the released `box run` once, with its credential source.
Start the checks once the host's `GET /v1/execution` reports
`repositoryRecipient.source`.

1. In the original chat, ask the Agent to change one file, push one branch
   with `git push https://github.com/<owner>/<repo>.git <branch>` and open a
   draft with `gh pr create --draft --repo <owner>/<repo> --head <branch>
--base main --title <title> --body <body>`. Inside Box `GITHUB_TOKEN` holds
   only a placeholder. Independently verify the file, branch, commit and draft
   on GitHub, and that GitHub records the App's bot account as the author of
   the pull request.
2. Try a push and a draft against another repository in the same account.
   OCE refuses both with `request_not_allowed` before Box sends them. Verify
   that the attempted ref stays unchanged.
3. Withdraw the active Agent's repository assignment through OCE without
   stopping the Agent. From the same execution, attempt a fresh fetch, push and
   draft. Verify that Box refuses each with the source's `access_withdrawn`
   code and that the attempted ref stays unchanged. Send an ordinary message
   and verify that the same chat still replies. Removing a repository from a
   saved draft does not by itself prove withdrawal from the running Agent.

Keep the observed host, chat and GitHub results separate. If a push or PR
request loses its response, check the original ref or PR before retrying. When
finished, stop the test Agent through OCE and verify retirement of its Box
execution and private route.
