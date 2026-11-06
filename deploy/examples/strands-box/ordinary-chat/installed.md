# Verify ordinary chat and workspace files on an installed Box Agent

Start with the [production installation](../../../../docs/guides/deploy/production-installation.md)
and the [Box Driver and host example](../README.md#connect-the-installation).
Use the same checkout to build the Controller, Worker, Gateway, and Box helper.
Use a dedicated Codex Agent with the normal Gateway authentication and a scoped
operator. Leave connectors, Git, repository access, and protected credentials
disabled. The installed chat and file checks below are pending.

## Prepare the original volume

Opt in to `workspaceNodeMode: file-only-v1` in the Box Driver configuration on
the API and Worker. Keep the [controlled inference settings](../driver/README.md#build-and-select).
Before the first pairing, leave custom `file-transfer` configuration and node
grants unset. Compute installs the file policy for the enrolled node.
Choose the `gpt-5` model through the controlled provider. Create the Agent
without initial workspace file staging, and deploy its first
revision once. The Worker creates the Harness claim before it calls the Box
host. Use an installation with a bound volume that the Box host can mount
directly, such as a statically bound local volume on that host. A copy of the
workspace cannot serve the Agent's live file operations.

Read the original claim in the Agent's execution namespace. Save its UID,
`spec.volumeName`, and Bound status. On the Box host, mount the four subpaths
of that exact volume as the nonroot runtime owner:

| Volume subpath                     | Host mount                           |
| ---------------------------------- | ------------------------------------ |
| `workspace`                        | `/home/node/workspace`               |
| `generated-images`                 | `/home/node/.codex/generated_images` |
| `codex-sessions`                   | `/home/node/.codex/sessions`         |
| `workspace-node-<agent>-<harness>` | `/home/node/.openclaw-node`          |

For the state subpath, `<agent>` and `<harness>` are the first 12 hex digits
of the SHA-256 of the Agent ID and of the literal `harness:codex`, respectively.
Bind mount each subdirectory directly, with no child mounts. The host checks
that each mount has the expected subpath name and that all four come from one
device and parent. Use fresh mode-`0700` directories. Keep the state private to the file node.
Enter the original claim name and its UID and volume name in the
[host configuration](../host/installed.example.json). Record each mount's
device and inode with `stat -c '%d %i'`. The separate node and Box both use the
same `workspace` subpath. Box has no device-state mount.

Stage the unpacked root filesystem of the exact selected public runtime image
in a fresh mode-`0700` directory outside the Box grants. Use the image's
canonical digest and check its source labels before unpacking. The normal
runtime owner needs read and execute access to the shipped Node and OpenClaw
files. Enter this directory and its device and inode as
`separateWorkspaceNode.rootfs` and `rootfsIdentity`. The host mounts that
image read-only for the file node. The host needs stock Bubblewrap with
`--bind-fd`, unprivileged user namespaces, and network namespaces enabled.
Compile the helpers using the [host build command](../README.md#prepare-the-host-and-verify-box),
and set `runtimeSha256` to the SHA-256 of the installed `workspace-node-runtime.mjs`.

Configure the actual external Gateway listener on a port above 1023 and set
the Installation's `gatewayRouting.endpointPort` to that port. Use the same
port, the Gateway DNS name, and the `/node` suffix in `workspaceNode.url`.
Set the listener's exact private IPv4 address in `workspaceNode.address`.
When Compute projects a Gateway CA, set `caSha256` to the SHA-256 of those
PEM bytes. The host connector forwards TLS bytes to the configured address
and port. The stock file node verifies the Gateway certificate with the
trusted chain, pairs once, and reconnects with its saved device credential.

## Start the controlled model

Follow the [one-tool setup](README.md#build-and-prepare) to stage the verifier
and seed a fresh synthetic marker. Set `workspaceVerifierSha256` in the host
configuration. Start the HTTPS fixture with a mode-`0600` JSON file containing
`address`, `port`, `boxAddress`, `certificate`, `key`, `runDirectory`, and
`nonce`. Use the selected private IPv4 listener address, the Box egress
source address, the trusted HTTPS server certificate and private key paths,
an empty mode-`0700` receipt directory, and the nonce from the operator run's
`expected.json`.

```sh
node deploy/examples/strands-box/ordinary-chat/serve-installed-model.ts "$MODEL_CONFIG"
```

Box must trust the fixture's HTTPS certificate through its normal upstream
trust. The fixture accepts only the public controlled inference marker from
the selected Box address. Use no model-provider credential.

## Verify one chat and the file node

Start the [host and approve the pending revision](../README.md#connect-the-installation).
Compare the pending volume and launch plan with the original revision before
approval. Use the original `ready.json` digest to start the
[host ingress](../ingress/README.md) on its approved TLS route. Wait until
the Worker observes the native Harness and its actual enrolled node and
activates that revision. Record the final Gateway and relay Pod UIDs and
the Agent Service UID. The preliminary Gateway can roll while Compute installs
the owner binding. Verify the selected final Gateway serves the checks below.

The Box Driver reads the bound claim in `provisionHarness` before the host
accepts the stock Compute command. The host gives Box the original Codex
program. Only the separate file node receives its state subpath and the
one-shot setup code. Kubernetes Compute observes that node through normal
enrollment. `KubernetesComputeDriver.reconcileHarnessTrust` installs the
original Box digest and ingress CA. The Driver and Gateway each require the
digest on the TLS upgrade. Replacing the claim, listener, or receipt closes
the affected path.

If you have operator access to the selected Gateway Pod, run the existing
owner check in the Gateway container. It reads the original binding and uses
that container's normal Harness environment without printing the credential.

```sh
umask 077
kubectl exec -i -n "$GATEWAY_NAMESPACE" "$GATEWAY_POD" -c gateway -- \
  node --input-type=module-typescript - \
  < deploy/examples/strands-box/ordinary-chat/owner-check.ts \
  > "$RUN/owner-wss.json"
```

Use an operator CLI context already authenticated to the installed Agent
Gateway. Save its exact WSS origin and path as `{"url":"..."}` in a private
`gateway.json` in the same run directory.

```sh
node deploy/examples/strands-box/ordinary-chat/operator.ts submit "$RUN" "$GATEWAY_CLI"
```

Copy only this run's controlled-model receipt to `$RUN/controlled-chat.jsonl`
and its Box policy receipt to `$RUN/box-records.jsonl` with mode `0600`.
Run `operator.ts verify "$RUN" "$GATEWAY_CLI"`. This checks the original reply,
tool result, marker inode, allowed tool, and refused alternate argument.

Use the [live workspace API](../../../../docs/reference/agents/workspace-files.md#live-file-access)
through the same Agent to read and update a disposable `USER.md`.
Check its bytes on the original volume. For a negative control, temporarily
use a workspace document symlink to a synthetic sibling file. The read and
write must be refused and the sibling's bytes must stay unchanged. Also
verify the public API rejects an outside-workspace path.
Confirm the same revision, bound claim, Gateway and relay Pod UIDs, Service
UID, and enrolled device after the checks. A synthetic model reply alone
does not verify the workspace node. Reconcile any uncertain chat or write
before deciding whether to submit another request.
