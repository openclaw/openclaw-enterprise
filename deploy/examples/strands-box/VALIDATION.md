# Strands Box pilot validation

The pilot exercises released Box v0.2.1 and Codex 0.164.0. The tests below cover different paths.

| Check | Observed result |
| --- | --- |
| Standalone native endpoint on emulated ARM Linux | The original endpoint rejected missing and incorrect authentication, then initialized with valid authentication. A direct native command wrote a workspace marker and an independent read matched it. Attempts to read or write a sibling file were refused and its bytes stayed unchanged. |
| Ordinary Gateway chat with a controlled model | A separate prototype sent an ordinary chat through the Gateway and ran a workspace tool inside the original Box. An independent check matched the workspace and marker. The alternate shell argument and sibling read and write attempts were refused. The narrower tool implementation proposed for the public branch still needs an installed run. |
| Hosted native ARM smoke | The first run stopped at Box startup with an unclassified failure. The second exposed the failure stage as executable mount inventory. Both stopped before native verification. See the [first run](https://github.com/openclaw/openclaw-enterprise/actions/runs/42165954170) and [second run](https://github.com/openclaw/openclaw-enterprise/actions/runs/42167069747). |

The direct native verifier supplies its workspace, executable and external sandbox policy explicitly. A model-driven turn must also carry the admitted workspace and policy through the Gateway and select a permitted executable. Earlier controlled chats stopped at namespace setup, marker access or the executable check even though direct native verification passed.

To reproduce the standalone check on a dedicated nonroot ARM64 Linux host, follow the [host preparation and two-terminal procedure](README.md#prepare-the-host-and-verify-box). The [automation script](verify-native-ci.sh) checks the exact checkout and pinned artifacts, then runs startup, native verification and cleanup on that host. A hosted runner may stop at mount inventory before the verifier starts.

An installed Agent still needs to complete ordinary chat and a workspace command, push to its assigned repository, and create a PR. It must also be denied an unassigned repository and lose Git access after withdrawal while the original chat continues. A maintainer published the pilot branch.
