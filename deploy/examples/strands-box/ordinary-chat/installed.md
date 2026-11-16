# Verify ordinary chat and workspace files on an installed Box Agent

Start with the [production installation](../../../../docs/guides/deploy/production-installation.md)
and [build and select the example Driver](../driver/README.md#build-and-select).
Use the same checkout to build the Controller, Worker, Gateway, and Box helper.
Use a dedicated Codex Agent with the normal Gateway authentication and a scoped
operator. Leave connectors, Git, repository access, and protected credentials
disabled. The installed chat and file checks below are pending.

Start with a ready OCE Agent Namespace. If the control plane is new, use
[normal Namespace provisioning](../../../../docs/guides/deploy/production-agents.md#prepare-each-namespace)
without the Box control mount or an Agent deployment. Return the Worker to
zero before the first Box rollout below.

## Verify the empty control export

Keep the Worker at zero replicas with its control claim disabled. Use
`controlSocketMode: worker-directory` for the host. Follow the
[control claim checks](../driver/README.md#before-enabling-the-worker-control-claim)
to verify the original Namespace, Node, bound control PVC and local PV, and
the empty owner-only export directory on that Node. This control claim
carries the Unix socket. The Worker will create a separate workspace claim
after deployment starts.

Prepare the pinned Controller, Gateway and relay images, host helpers, and
[fixed workspace verifier](../workspace-verifier/README.md) before rollout.
Stage the unpacked root filesystem of the exact selected public runtime image
in a fresh mode-`0700` directory outside the Box grants. Use the image's
canonical digest and check its source labels before unpacking. The nonroot
runtime owner needs read and execute access to the shipped Node and OpenClaw
files. The host mounts that image read-only for the file node. The host needs
stock Bubblewrap with `--bind-fd`, unprivileged user namespaces, and network
namespaces enabled. Compile the helpers with the
[host build command](../README.md#prepare-the-host-and-verify-box).

In that Agent Namespace, use steps 1–2 in
[Connect one Agent Gateway to the Box host](../ingress/README.md) to allocate
the private relay Service, set `network.providerHarness`, and prepare TLS.
Keep the private key with the ingress owner. Start ingress later, after the
original Box writes `ready.json`. Configure the Gateway listener above
port 1023 and set the Installation's `gatewayRouting.endpointPort` to that
port before the first deployment.

Opt in to `workspaceNodeMode: file-only-v1` in the Box Driver configuration on
the API and Worker. Keep the [controlled inference settings](../driver/README.md#build-and-select).
Leave custom `file-transfer` configuration and node grants unset before the
first pairing. Compute installs the file policy for the enrolled node.
Select `gpt-5` through the controlled provider. Use the normal
[Agent workflow](../../../../docs/guides/deploy/production-agents.md#configure-the-agent-runtime)
to save the dedicated Codex Agent in a stopped state, without initial
workspace file staging.

## Prepare the original volume

After the empty export checks pass, [mount it read-only in one Worker](../driver/README.md#mount-the-empty-control-directory).
Verify the actual Worker mount, then submit the stopped Agent's first
deployment once through [the guarded OCE workflow](../../../../docs/guides/deploy/production-agents.md#prepare-transport-credentials-and-deploy). The Worker creates the
Harness claim before it calls the Box host. Use a workspace volume that the
original Box host can mount directly, such as a statically bound local
volume on that host. A copy cannot serve the Agent's live file operations.

Track that deployment and revision through OCE. Continue only while the
original deployment is still in progress, within its normal deadline. If
it fails or its outcome is unknown, stop and reconcile that exact revision.
Do not submit another deployment, create a replacement revision, or assume
the Worker will retry a terminal operation.

Read the original Harness claim in the Agent's execution namespace.
Match the Namespace and Agent to the original revision, then verify the
Bound claim's UID and `spec.volumeName`. Check the original PV's UID,
`claimRef`, and placement on the Box host. Record the claim and PV before
binding the four subpaths of that volume as the nonroot runtime owner:

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
device and parent. Use fresh mode-`0700` directories. Keep the state private
to the file node.
Enter the original claim name and its UID and volume name in the
[host configuration](../host/installed.example.json). Record each mount's
device and inode with `stat -c '%d %i'`. The separate node and Box both use the
same `workspace` subpath. Box has no device-state mount.

Enter the staged image directory and its device and inode as
`separateWorkspaceNode.rootfs` and `rootfsIdentity`. Set `runtimeSha256` to
the SHA-256 of the installed `workspace-node-runtime.mjs`.

Use the Gateway listener configured above. Set `workspaceNode.url` to its
DNS name and port with the `/node` suffix.
Set the listener's exact private IPv4 address in `workspaceNode.address`.
When Compute projects a Gateway CA, set `caSha256` to the SHA-256 of those
PEM bytes. The host connector forwards TLS bytes to the configured address
and port. The stock file node verifies the Gateway certificate with the
trusted chain, pairs once, and reconnects with its saved device credential.

## Start the controlled model

Use the verifier prepared above. After binding the original workspace,
follow the seed step in the [one-tool setup](README.md#build-and-prepare)
to write a fresh synthetic marker. Use the installed host below rather
than starting the standalone launcher. Set `workspaceVerifierSha256` in the host
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

## Start the held host and approve

While the original deployment is still in progress, complete the
[installed configuration](../host/installed.example.json) with the original
Driver, Namespace, Agent and revision identities, actual image, endpoint,
and verified workspace. Use `controlSocketMode: worker-directory` and the
same `runtimeDir` and export checked above. Select held mode: use a fresh
mode-`0700` `approvalDir` outside the Worker mount and all Box grants, and
omit `profileSha256`. As the original nonroot owner, set
`BOX_INSTALLED_CONFIG` to the absolute path of the mode-`0600` file.

```bash
node deploy/examples/strands-box/host/control.ts "$BOX_INSTALLED_CONFIG"
```

`strands-box-control: ready` means only that the socket is listening. Within
the original deployment deadline, wait for the Worker to write
`runtimeDir/pending.json`. It can do so while you check the socket; pending
does not approve or start Box. If the deadline passes, the revision fails,
or any identity or outcome is uncertain, stop and reconcile the original
revision without another deploy.

Before approval, [verify the live Worker control mount](../driver/README.md#verify-the-live-worker-control-mount).
Privately match the pending owner, revision and requirements to the original
OCE deployment. Confirm the file-only mode, volume UID and name, and launch
plan digest. Do not dump host config, state files, credentials, or socket
response bodies. Set `BOX_REVISION_ID` and `BOX_REQUIREMENTS_DIGEST` from
the verified receipt, then approve that exact request once.

```bash
node deploy/examples/strands-box/host/control.ts approve "$BOX_INSTALLED_CONFIG" \
  "$BOX_REVISION_ID" "$BOX_REQUIREMENTS_DIGEST"
```

The Worker can continue the same deployment on its next reconciliation.
Do not reuse this approval if the host, Worker, mount or revision changes.

## Verify one chat and the file node

Use the original `ready.json` digest to start the
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
digest on the TLS upgrade. That check identifies the native endpoint; it does
not identify the host directory mounted in the Worker. If the control volume, directory, Worker or socket changes, hold admission
and reconcile the original revision. Recheck the live identities before
admitting work. Do not treat a restart as the first empty-export rollout.

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
