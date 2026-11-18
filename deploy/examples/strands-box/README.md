# Run one dedicated Codex Agent in Strands Box

## What this is

OpenClaw Enterprise (OCE) runs a dedicated Codex Agent in
[Strands Box](https://github.com/strands-agents/box) as a second Sandbox, beside
OpenShell. The example is an installable Driver package built on OCE's own
Driver interfaces. With `protectedRepository` set, the
[paired protected registration](driver/README.md#paired-protected-registration)
gives the Agent one GitHub repository and a model. Box injects the GitHub
token and the model key at egress, on its own routes, and asks OCE about each
request through the Worker; the workload holds only Box placeholders. The Agent
uses [stock `git` and `gh`](git/README.md): no custom remote, helper or token
in its environment.

## What was proven

An Agent inside OCE and Box pushed a branch and opened a draft pull request on
github.com with a token that OCE's Worker minted from the GitHub App key. GitHub
recorded the App's bot as the author. Each pull request was closed afterwards:

- 2026-11-17: [freeqaz/oce-cp-dogfood#4](https://github.com/freeqaz/oce-cp-dogfood/pull/4).
  The same execution was refused a Git request to another repository and an
  API request outside its grant, and after the repository was withdrawn it was
  refused the next request while its chat kept answering.
- 2026-11-18: [#5](https://github.com/freeqaz/oce-cp-dogfood/pull/5),
  [#6](https://github.com/freeqaz/oce-cp-dogfood/pull/6) and
  [#7](https://github.com/freeqaz/oce-cp-dogfood/pull/7), the last on this
  branch after it was merged with OCE main.
- 2026-11-18: [#8](https://github.com/freeqaz/oce-cp-dogfood/pull/8), on this
  branch as handed off, with the [Box build below](#which-box-build).

Each run used a real model whose key Box injected per request, and a search of
the workload's environment, files, Box's runtime directory and the logs found
neither the model key nor a GitHub token nor the App key.

They ran on one Linux x86-64 virtual machine with K3s: OCE's API, Worker and
images built from this branch, and the Box host on the Worker's node, with
Box's experimental x86-64 support. Runs #4 to #7 used earlier builds of these
fork branches on an older upstream base; #8 used the build below.

Not proven:

- An installed run on Linux ARM64, the only Linux platform Box releases today
  (v0.2.3, 2026-11-17, ships Linux ARM64 and macOS only). The native checks in
  [VALIDATION.md](VALIDATION.md) ran on ARM64 with released Box, without OCE's
  protected path.
- More than one execution at a time: each Box host runs one execution, and
  one host serves one Driver selection.
- Any Agent but a dedicated Codex Agent with an OpenAI-compatible API key and at
  most one GitHub repository.

## Which Box build

The protected path does not run on a released Box. The build comes from the
public fork [`freeqaz/box`](https://github.com/freeqaz/box): its `dogfood/main`
at `956764b58f2c` is upstream `5ed679f` (the v0.2.3 release commit) with these
branches merged:

| Fork branch                                                                                                  | What it changes in Box                                                                                                        | Why OCE needs it                                                                                                                                                         | Needed      |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| [`feature/request-credential-source`](https://github.com/freeqaz/box/tree/feature/request-credential-source) | After policy permits a request on a credentialed route, the gateway asks a configured source for the credential, or a refusal | OCE decides each GitHub request and releases the model key per request, so no token sits in `box run`                                                                    | required    |
| [`fix/containment-init-signals`](https://github.com/freeqaz/box/tree/fix/containment-init-signals)           | Seccomp permits `kill` and `rt_sigtimedwait`                                                                                  | OCE starts the Harness under `tini`, which otherwise dies at start                                                                                                       | required    |
| [`feature/gateway-upstream-ca-file`](https://github.com/freeqaz/box/tree/feature/gateway-upstream-ca-file)   | `[gateway] upstream_ca_file`: one extra CA bundle for upstream TLS                                                            | Only for a privately signed model route (host `upstreamCa`)                                                                                                              | conditional |
| [`fix/shell-stdin-passthrough`](https://github.com/freeqaz/box/tree/fix/shell-stdin-passthrough)             | A program the Shell starts in its own sandbox reads the command's stdin                                                       | Only when Codex runs a native hook inside Box (host `nativeHookRelay`): the hook reads its event on stdin. The pinned OpenClaw registers no pre-tool-use hook by default | conditional |
| [`fix/locked-mount-flags`](https://github.com/freeqaz/box/tree/fix/locked-mount-flags) (not in the build)    | A remount keeps options the user namespace locked                                                                             | Not needed: keep `box_dir` off a `noexec` mount, or remount `/run` with `exec`                                                                                           | no          |

On Linux x86-64, upstream Box's experimental support is enough; the host sets
`EXPERIMENTAL_X86_SUPPORT=TRUE` for `box run`. On ARM64 it is not needed.

Get the source and build the three programs:

```bash
git clone https://github.com/freeqaz/box.git && cd box
git checkout 956764b58f2c5ccb12bb7048fd1ced3d8ca1b5d4
cargo build --release --locked -p strands-box -p strands-box-containment
```

If that commit is not on the fork yet, the same tree
(`dfd97bd7d136`) comes from the published branches:

```bash
git checkout -b demo origin/dogfood/main   # 5ae909afc5
git merge --no-ff origin/fix/containment-init-signals
git merge --no-ff origin/fix/shell-stdin-passthrough
```

Install `strands-box`, `strands-box-sock-alias` and
`strands-box-contain-trampoline` from `target/release` side by side with a
fresh `box_dir`, and point the host's `boxBin` at `strands-box`.

## Read next

- [RUNBOOK.md](RUNBOOK.md): set up and run a valid end-to-end test against
  real GitHub, step by step.
- [KNOWN-GAPS.md](KNOWN-GAPS.md): what an operator must know, and what we ask
  of Box.
- [VALIDATION.md](VALIDATION.md): what ran where.
- [The Driver README](driver/README.md): build, select and configure the Driver.

The steps below verify a Box host, connect it to an installation, give a
protected Agent a model, and repeat the GitHub checks.

## Prepare the host and verify Box

Use a dedicated Linux host, ARM64 (such as a Graviton EC2 instance) or x86-64
with the [Box build above](#which-box-build), with a nonroot
operator account and private connectivity to the installation. Use the
repository's [Node.js version](../../../package.json) and Codex from the matching
[OCE runtime build](../../runtime/README.md).

The native check and the controlled Gateway chat below run on a released Box.
An installed Agent needs the [Box build above](#which-box-build) instead: OCE
starts its Harness under `tini`, and the protected path asks the request-time
source. For the
native check on ARM64, download the
[Strands Box v0.2.2 Linux ARM64 release](https://github.com/strands-agents/box/releases/tag/v0.2.2)
into a new directory on the host.
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

An installed host can instead run the Harness from a prepared read-only image
root; see the optional [prepared Harness image profile](host/harness-image.md),
which was not part of the [proven runs](#what-was-proven).

Codex must find no `git` or `gh` by name. Before Box starts, the host refuses
an exec grant covering either one, and an admitted `PATH` entry that is empty
or relative, lies under `/proc`, `/dev` or `/sys`, loops, or passes through
Box's loader directories, git's helper directories or a writable directory.
It also refuses any `git` or `gh` in the directories the runtime adds to
Codex's `PATH`, or a link in their place: `$HOME/.local/bin`,
`$HOME/.openclaw/tools/node/npm/bin` and `$CODEX_HOME/tmp/arg0`. The host log
then shows `strands-box-diagnostic source=box stage=input
reason=agent_exec_covers_git` before `startup refused at stage-inputs`.

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

## Give a protected Agent a model

With `protectedRepository`, the paired registration can also supply a
Credential Gateway view for one model source type, `openai` (API key). Box then
injects the key on each `POST <model route>/v1/responses` request, and the
workload's `OPENAI_API_KEY` holds only Box's placeholder.

1. Apply [model-gateway-rbac.yaml](model-gateway-rbac.yaml) with your release
   namespace. Set the Sandbox Driver's `modelGateway.secretNamespace` to its
   namespace, and set `controlledInference.modelBaseUrl` (and `address`) to the
   model route. In the Installation, select the package as the Credential
   Gateway: `drivers.credential_gateway: { id: <Sandbox Driver ID>, configuration: {} }`.
   The API and Worker must reach the Kubernetes API.
2. On the Box host, add `protectedModel: { revocationDir }` to the host
   configuration: a private directory outside every grant and the runtime
   directory. Revoke receipts are kept there across host restarts.
3. Store the API key as an OCE Secret, then register the source:
   `POST /namespaces/:namespaceId/credential-sources` with
   `"type": "openai"`, `"config": { "authorized_base_url": <modelBaseUrl> }`
   and `"secrets": { "api_key": <Secret ref> }`. See
   [credential sources](../../../docs/reference/credential-sources.md#register-a-source).
   The package copies the value into its own Secret.
4. List the source in the Agent's `credentialSources`, set `harnessAuth` to
   `{ "method": "credential_source", "sourceId": <source ID> }` and the model
   provider's `baseUrl` to the same route, then deploy.

Each model request is answered only for this execution's Box, while the
attachment is live. Withdrawing the source refuses the next request before any
byte reaches the provider; the host keeps the receipt, and that revision stays
refused ([permanent](KNOWN-GAPS.md#a-model-revoke-is-permanent-for-its-revision)).
`updateSource` reaches the next request without a restart. Withdrawing the
repository leaves the model working, and the reverse. See the
[known gaps](KNOWN-GAPS.md#the-package-keeps-the-protected-model-key-at-rest).

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

The Box host starts `box run` from the [Box build above](#which-box-build)
once, with its credential source.
Start the checks once the host's `GET /v1/execution` reports
`repositoryRecipient.source`.

1. In the original chat, ask the Agent to change one file, push one branch
   with `git push https://github.com/<owner>/<repo>.git <branch>` and open a
   draft with `gh pr create --draft --repo <owner>/<repo> --head <branch>
--base <default-branch> --title <title> --body <body>`. Inside Box `GITHUB_TOKEN` holds
   only a placeholder. Independently verify the file, branch, commit and draft
   on GitHub, and that GitHub records the App's bot account as the author of
   the pull request.
2. Try a push and a draft against another repository in the same account.
   OCE refuses the push with `request_not_allowed` before Box sends it. GitHub
   refuses the draft, because the installation token covers only the assigned
   repository. Verify that the attempted ref stays unchanged.
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
