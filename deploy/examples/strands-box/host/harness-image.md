# Select a prepared Harness image for an installed host

An installed control host can opt in by setting `harnessImageReceipt` to the
absolute path of the original operator's root-owned, read-only JSON receipt.
This optional profile was not part of the [proven runs](../README.md#what-was-proven).
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
