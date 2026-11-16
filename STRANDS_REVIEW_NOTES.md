# Temporary Strands review and validation guide

Remove this guide after review. The maintained procedures are the [Box example](deploy/examples/strands-box/README.md), [sender rehearsal](docs/testing/strands-box.md), and [protected repository custody guide](docs/testing/protected-repository-custody.md).

## Run the local sender rehearsal

Install the frozen dependencies on Linux. Use a nonroot account and the direct native executable of the Codex version pinned in the [runtime recipe](deploy/runtime/Dockerfile).

```sh
pnpm install --frozen-lockfile
export OCC_TEST_STANDING_GIT_CODEX=/absolute/path/to/native/codex
node scripts/strands-fast.ts
```

Expect one native conversation case and five sender controls, with zero skips and successful cleanup. The native case uses real Codex, Git, and mutual TLS with controlled model and Git origins. It checks a model reply, a fresh fetch, refusal after withdrawal before any new origin request, and another reply in the same conversation. The runner prints the results directory. Check both CI receipts and `summary.json` for the same source commit, exact test counts, and cleanup. Use `--repeat 5` for samples or add `--serial` to run the same selections in order.

## Run inside an ARM64 QEMU guest

This example boots a disposable ARM64 guest on an x86 Linux host with QEMU's software CPU emulator. Use a trusted, bootable ARM64 QCOW2 disk with a nonroot SSH account, its independently verified SSH host key, and matching UEFI firmware. The disk and firmware code stay read-only. Use a free loopback port and absolute input paths. [QEMU ARM virtual platform](https://www.qemu.org/docs/master/system/arm/virt.html)

```sh
RUN=$(mktemp -d)
qemu-img create -f qcow2 -F qcow2 -b "$ARM64_BASE_IMAGE" "$RUN/guest.qcow2"
cp "$ARM64_UEFI_VARS_TEMPLATE" "$RUN/vars.fd"
qemu-system-aarch64 \
  -machine virt -accel tcg -cpu max -smp 4 -m 8192 \
  -drive if=pflash,format=raw,readonly=on,file="$ARM64_UEFI_CODE" \
  -drive if=pflash,format=raw,file="$RUN/vars.fd" \
  -drive if=virtio,format=qcow2,file="$RUN/guest.qcow2" \
  -netdev user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22 \
  -device virtio-net-pci,netdev=net0 -nographic
```

In a second terminal, connect with the expected host key stored for `[127.0.0.1]:2222`.

```sh
ssh -p 2222 -i "$GUEST_SSH_KEY" \
  -o UserKnownHostsFile="$GUEST_KNOWN_HOSTS" \
  -o StrictHostKeyChecking=yes "$GUEST_USER@127.0.0.1"
```

In the guest, require `uname -m` to report `aarch64`. Check out the exact source under review, select the corresponding native Linux ARM64 Codex executable, then repeat the local rehearsal. For the independent Box smoke, run `bash deploy/examples/strands-box/verify-native-ci.sh "$(git rev-parse HEAD)"`. It checks whether the guest permits Box's required namespaces before it downloads the pinned release. The guest recipe is unverified on this branch. Keep guest and native-host results separate. Shut down the guest, wait for QEMU to exit, then remove the disposable disk and firmware variables.

## Exercise the installed flow

1. Run the [ordinary installed Agent procedure](deploy/examples/strands-box/ordinary-chat/installed.md) with repository access disabled. Match the original workspace claim, activate through the Worker, and verify authenticated Gateway chat, Box isolation, and file access to the same workspace.
2. Full protected qualification requires a Box provider that implements the paired [Sandbox and Credential Proxy contracts](docs/contributing/credential-proxy-driver.md). It must bind the actual Box execution to the sender's mutual-TLS connection, install Worker-owned repository material, and release only that execution. It also needs an admitted repository credential issuer. This branch supplies the ordinary Driver and a separately testable sender. The ordinary Driver refuses protected mode. The pinned stock Box proxy terminates workload TLS. Configuring Git's client certificate inside Box therefore cannot authenticate the upstream sender connection. [Box TLS implementation](https://github.com/strands-agents/box/blob/d9346bf0d281153ea7dc6338ad1f0b7e122be687/crates/egress-gateway/src/intercept/mitm/tls.rs)
3. With that supplier and issuer available, use the same installed Agent and conversation to fetch an independently verified fresh commit, push a harmless marker, and create one draft. Read back the exact GitHub actor, repository, ref, commit, base, head, and draft state. Exercise an out-of-scope repository or ref, withdraw access, and require a fresh Git attempt to fail before provider traffic while the same model conversation still replies. Reconcile uncertain effects before any retry. [Protected acceptance procedure](docs/testing/protected-repository-custody.md#qualify-installed-custody)
