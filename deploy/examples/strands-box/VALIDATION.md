# Strands Box pilot validation

Installed OCE runs with the protected path passed on one Linux x86-64 virtual
machine with the [Box build](README.md#which-box-build); see
[What was proven](README.md#what-was-proven). Standalone workspace
verification passed on AWS Graviton with Box v0.2.1 and Codex 0.164.0. A
separate Gateway run completed one chat with a local model fixture.

The [native check](README.md#prepare-the-host-and-verify-box) pins Box v0.2.2.
The records below retain the versions actually tested; updating the setup pin
does not repeat those qualification runs.

| Check                                                        | Observed result                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standalone native endpoint on emulated ARM Linux             | The original endpoint rejected missing and incorrect authentication, then initialized with valid authentication. A direct native command wrote a workspace marker and an independent read matched it. Attempts to read or write a sibling file were refused and its bytes stayed unchanged.                                                                                                                                                                          |
| Standalone native workspace verification on AWS Graviton     | The [public standalone verifier](README.md#prepare-the-host-and-verify-box) ran as UID 1000 on a dedicated ARM64 Linux Graviton host with released Box v0.2.1 and Codex 0.164.0. It wrote a workspace marker, and an independent read matched its bytes. Sibling reads and writes were refused, the sibling's bytes stayed unchanged, and cleanup completed.                                                                                                         |
| Public read-only workspace tool in a controlled Gateway chat | An ordinary chat with a synthetic model exercised the declared tool from `3f7bd36bb64e3c1c92a39e50b5eed8035bbcd688`. An independent check matched the marker file’s device, inode and digest; the file stayed unchanged. Stock Box recorded one named permit and one default denial for the alternate argument. A separate native check refused sibling reads and writes and confirmed unchanged bytes. This earlier check used a separate controlled Gateway setup. |
| Gateway built from the branch after merging public main      | On 2026-11-06 at 07:57 UTC, the stock, uninstrumented AMD64 Gateway built from `275e2053` completed one ordinary CLI chat with Box on emulated ARM. The [local synthetic model fixture](ordinary-chat/README.md) used no upstream model credentials. The chat returned a tool result and a final assistant reply. Independent readback matched the marker's inode, and Box refused the alternate argument.                                                           |
| OCE installation bootstrap on ARM K3s                        | The API and Worker built from branch ancestor `0e86e99b` both reached Ready. The Worker reached Ready after its existing marker probe was given ten seconds instead of one. Authenticated `GET /installation` returned HTTP 200. The normal API created the first Namespace, and an independent Kubernetes read confirmed it. This bootstrap did not deploy a Box Agent.                                                                                             |
| Hosted native ARM smoke                                      | The first run stopped at Box startup with an unclassified failure. The second exposed the failure stage as executable mount inventory. Both stopped before native verification. See the [first run](https://github.com/openclaw/openclaw-enterprise/actions/runs/42165954170) and [second run](https://github.com/openclaw/openclaw-enterprise/actions/runs/42167069747).                                                                                            |

The direct verifier supplies the workspace, executable and sandbox policy. The Gateway must carry those settings through the model-driven turn. In the earlier Gateway run, the `openai/` model reference selected a different provider. The Gateway accepted the chat, but no tool result or assistant reply was observed.

## What AWS can reproduce now

1. Start with the [host preparation and two-terminal native check](README.md#prepare-the-host-and-verify-box) as a nonroot user on a dedicated ARM64 Linux host. With `jq` on `PATH`, the [automation script](verify-native-ci.sh) checks the exact checkout and pinned artifacts, runs the native verifier, and cleans up. A hosted runner may stop at mount inventory before verification.
2. Follow the [controlled Gateway chat procedure](ordinary-chat/README.md). Keep the `codex/box_repro_fixture/gpt-5` model reference. Confirm the original reply and tool result, then verify the marker independently. A chat acceptance alone is insufficient.

3. For an installed Agent with GitHub and a model, follow the
   [README](README.md) from [Which Box build](README.md#which-box-build) on.

## Installed runs on Linux x86-64

The protected-path runs on one virtual machine with K3s, from 2026-11-17 on,
are listed under [What was proven](README.md#what-was-proven), with their pull
requests and what was refused.

## Tests outside the hosted suites

[`git/controlled-git-model.ts`](git/controlled-git-model.ts) is a test fixture:
a scripted model for dry runs, not part of the Driver. Five test files run in
no hosted suite (`tests/conformance/strands-box-enrollment.test.ts`,
`-git-model`, `-model`, `-model-native` and `-native-hook`): they were run by
hand with `node --test` on a Linux x86-64 test machine, and
`strands-box-model-native.test.ts` with a real Box on the virtual machine above.
