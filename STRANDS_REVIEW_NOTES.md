# Temporary Strands review and validation guide

Remove this file after review. The maintained instructions are in
[Strands sender testing](docs/testing/strands-box.md) and
[protected repository custody](docs/testing/protected-repository-custody.md).

## What this branch changes

`scripts/strands-fast.ts` runs two existing CI selections concurrently: the
`strands-sender` native Codex rehearsal and the five Strands sender controls.
The runner retains each selection's original log, result, state, test counts,
and cleanup result. Each run also writes `summary.json` with timings and the
Codex executable hash. `--serial` runs the same selections in sequence, and
`--repeat` collects multiple samples.

The rehearsal starts controlled model and Git HTTPS origins, a real Strands
repository sender, and one native Codex process. It checks a model turn, a real
Git fetch, refusal of a fresh fetch after withdrawal, and conversation
continuity through another model turn. The origins and credential authority are
fixtures. This branch does not start Box, Kubernetes, or an installed Agent.

## Test on a Linux host

Use a nonroot Linux account, Node.js 24.22.1 or newer, the pinned pnpm version,
Git, OpenSSL, and a trusted native Linux Codex executable for the host's CPU.
Prepare the repository dependencies once:

```sh
pnpm install --frozen-lockfile
export OCC_TEST_STANDING_GIT_CODEX=/absolute/path/to/codex
node scripts/strands-fast.ts --codex "$OCC_TEST_STANDING_GIT_CODEX"
```

The command prints its result directory. Check both original receipts and the
summary. At this branch's current selection, require one native case and five
sender cases, zero skips and failures, successful cleanup, and matching source
commits. An independent Linux x86-64 run with Node 24.22.1 and Codex 0.164.0
passed all six cases in 4.675 seconds, or 5.689 seconds including setup. Those
figures are one local sample. To compare timings:

```sh
node scripts/strands-fast.ts --repeat 5
node scripts/strands-fast.ts --repeat 5 --serial
```

## Run the same check in an ARM64 QEMU guest

This is an example for an x86 Linux host using QEMU's software CPU emulator
(TCG). QEMU is external tooling; this branch has no guest-image builder or
QEMU launcher. Supply a trusted, bootable ARM64 Linux QCOW2 image with an SSH
account, its verified SSH host key, and matching UEFI firmware code and variable
images. Keep the original disk and firmware unchanged by making private copies:

```sh
RUN=$(mktemp -d)
qemu-img create -f qcow2 -F qcow2 -b "$(realpath "$ARM64_BASE_IMAGE")" "$RUN/guest.qcow2"
cp "$ARM64_UEFI_VARS_TEMPLATE" "$RUN/vars.fd"
qemu-system-aarch64 \
  -machine virt -accel tcg -cpu max -smp 4 -m 8192 \
  -drive if=pflash,format=raw,readonly=on,file="$ARM64_UEFI_CODE" \
  -drive if=pflash,format=raw,file="$RUN/vars.fd" \
  -drive if=virtio,format=qcow2,file="$RUN/guest.qcow2" \
  -netdev user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22 \
  -device virtio-net-pci,netdev=net0 -nographic
```

In a second host terminal, connect using the guest's expected host-key record:

```sh
ssh -p 2222 -i "$GUEST_SSH_KEY" \
  -o UserKnownHostsFile="$GUEST_KNOWN_HOSTS" \
  -o StrictHostKeyChecking=yes "$GUEST_USER@127.0.0.1"
```

Inside the guest, confirm `uname -m` reports `aarch64`. Check out this branch,
install the same prerequisites, and use a Linux ARM64 Codex executable:

```sh
git clone --single-branch --branch codex/strands-fast-harness-1111 \
  https://github.com/openclaw/openclaw-enterprise.git
cd openclaw-enterprise
pnpm install --frozen-lockfile
export OCC_TEST_STANDING_GIT_CODEX=/absolute/path/to/linux-arm64/codex
node scripts/strands-fast.ts --codex "$OCC_TEST_STANDING_GIT_CODEX"
```

Keep guest timings separate from native-host timings. The rehearsal has its own
90-second test timeout; a TCG timeout is an inconclusive guest result, and the
fast CLI has no timeout override. Shut down the guest normally, wait for the
original QEMU process to exit, retain any needed results, then remove the
disposable overlay and variable image. This example has not been executed on
the review host.

## Complete the installed flow separately

1. Install the selected Driver and runtime in an OCE deployment.
2. Provision the Worker's approved repository credential source. Keep App
   signing keys and raw credentials outside the Agent and its workspace.
3. Register the model source, deploy the Agent revision, install its selected
   Box policy, and verify that Compute releases the intended runtime.
4. Ask that installed Agent to complete an authenticated model turn, commit a
   harmless marker, push a fresh branch, and open a draft on the authorized
   repository.
5. Independently verify the GitHub App actor, repository, branch, commit SHA,
   marker, draft state, base, and head. Join that result to the Agent's turn and
   sender receipts.
6. For full withdrawal qualification, withdraw Git access, require a fresh Git
   operation to fail without provider traffic, and continue the same model
   conversation.

Running the fast harness inside QEMU proves the rehearsal in that guest. Box
containment and the installed GitHub journey each require their own real runtime
evidence; see the [runtime adapter contract](docs/testing/protected-repository-custody.md#reuse-the-rehearsal-with-another-runtime).

## Open review gaps

- The fast CLI catches signals directed to itself, but terminal Ctrl-C also
  reaches the child CI runners in the same process group. Their signal handling
  can interrupt fixtures before normal cleanup finishes and leave a detached
  native child running. Verify interruption through a real terminal process
  group before relying on cleanup after Ctrl-C.
- If a runner exits before producing a readable result, the CLI throws before
  writing `summary.json`. Original logs and any completed sibling receipts can
  remain in the printed directory. Inspect those originals before retrying.
- The rehearsal asserts its four model/Git observations inside the test, but
  the CI reporter does not retain passing test diagnostics as four structured
  receipt records. A passing count does not provide those separate records.
- A failed summary currently contains the same `proof` description as a passing
  summary and reports elapsed time for the failed sample. Check `passed`, both
  original receipts, and their test counts before interpreting that text or
  comparing timings.
- The wrapper accepts any nonzero all-passing test count. The sender CI file
  does not pin its five expected test names, so deleting a case could make a
  five-case run report success. Check the one-plus-five inventory explicitly.
- The CLI's automated tests cover argument and prerequisite failures, not the
  full successful or interrupted six-case run. The QEMU procedure, actual Box
  isolation, and installed GitHub push/draft remain separate validation gaps.
- The CLI tests use a URL pathname as a subprocess path. A checkout directory
  containing spaces causes the tests to fail because the path remains escaped.
