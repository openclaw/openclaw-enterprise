# Verify the local Strands Box integration

The selected Strands adapter explicitly enables Box's experimental Linux runtime
with `EXPERIMENTAL_LINUX_SUPPORT=TRUE` in the trusted Box supervisor. This selects
the qualified platform; it does not change Box or Pod security policy.

Select `strands-sandbox` explicitly with the Kubernetes installation and Codex
preset. It is excluded from `all` and the hosted advisory jobs: the Linux ARM64
runtime, local Box container-backend patches and a node-installed setup seccomp
profile require a prepared environment. Keep Restricted admission, default proc
masks and separate container PID namespaces. This scenario does not
qualify production distribution, other architectures or multi-Agent capacity.

The fixture selects an existing, stopped, test-owned Agent and its model Secret.
Before any mutation, its exact `api_key` binding must match `modelSecretId` in
the same Namespace. The Secret's consumer inventory must be complete, readable
and limited to that Agent, with no Configuration, Credential Source or pending
provisioning consumers. A mistyped or shared Secret is refused before key
replacement or lifecycle cleanup.
The test replaces that Secret, deploys the Agent, runs a model tool that writes
and reads its workspace, checks file/network refusals and Harness authentication,
deletes the exact Sandbox Deployment to verify loss observation, then stops and
redeploys normally. The Gateway and Harness must mount different PVCs. A second
model turn in the same conversation reads the first marker and executes a workspace
skill. The skill fixture is installed through native `file_write` and verified
through `file_fetch` with its exact size and SHA-256 before any model turn; model
transcription of YAML frontmatter is not a fixture dependency. Fresh conversations
before and after redeployment must call native
`memory_search` and retrieve a synthetic fact from the remote workspace. Configure
`plugins.allow` to include `memory-core` and `memory.search.provider: none` for
this keyword-only scenario; selecting a memory slot alone does not grant plugin
tools. The test does not bypass plugin authorization or replace memory tools.
Recall prompts use the invocation advertised by Codex, `exec` calling
`tools.memory_search`. Every model tool error still fails the scenario, and the
actual nested memory-tool receipt remains mandatory. Preserve failed model and
fixture attempts separately; a later pass must not relabel them as successes.
Native memory indexing is asynchronous. The scenario observes convergence through
the authorized `memory_search` tool before its fresh-conversation assertion; it
does not inject index rows or force a rebuild. It records the indexing delay and
does not assert immediate read-after-write consistency. The management
`memory.search` RPC uses a transient CLI manager and is insufficient to establish
the normal tool's watcher lifecycle.
The same scenario also exercises OCC workspace-file APIs, remote Unicode,
binary and empty files, overwrite refusal, provider Pod replacement and live
revision retirement. It creates a second Agent with initial workspace files,
grants that Agent access to the selected model Secret, checks separate PVCs and
foreign-node refusal, and runs two overlapping real model turns. Deletion must
remove the second Agent's workloads, PVCs and exact IAM bindings while preserving
the retained Agent. Two Agents establish functional concurrency, not capacity.
The concurrency case invokes native `exec_command` and `write_stdin` through
code mode and rejects tool errors. A process session ID is not a code-mode
`wait` cell ID.
The [OCE code-mode entrypoint](../guides/deploy/strands-code-mode.md) keeps native code
mode enabled under Box's existing W^X restriction. A separate real model call
must compute JavaScript inside that host, with no Node globals.
The second Agent uses a fresh QA-owned Configuration. Its temporary sharing of
the model Secret is explicit. Cleanup permits only the retained Agent and this
run's recorded second Agent as consumers, and removes the second Configuration.
Immediately before installing the key, QA rechecks the stopped Agent's binding,
Configuration generation and complete exclusive consumer inventory, including
that Agent. Withdrawal can scrub an installed key after detachment if no foreign
consumer has appeared.

Semantic memory uses OpenClaw's native `local` provider and vector storage.
The optional [offline memory image](../guides/deploy/local-memory.md) packages
the unchanged llama.cpp plugin and its pinned default embedding model. Native
`localService` configuration manages a loopback-only server; no embedding
credential, runtime download or Gateway public egress is required.
The test compares keyword-only and synonym retrieval over a synthetic remote file,
then requires a real model `memory_search` result. This phase clones the native
Configuration and rebinds only the stopped test Agent. It never edits the
original Configuration, even when another Agent shares it. Cleanup restores
the original binding and derived index, then removes the unchanged QA clone.
Concurrent binding or generation changes fail cleanup and retain the conflicting
resource for inspection rather than overwriting it. The separate chat credential uses the
documented Harness Secret delivery path, never plaintext Configuration values.
Twelve waves of four distinct concurrent semantic queries, five seconds apart,
exercise the actual local embedding service. Record cgroup usage, reclaimable file cache, limits,
OOM counters and Pod restarts; all limits and identities must remain unchanged.
This bounded workload is not a production capacity benchmark.
The synonym-only fixture uses one fixed `memory/oce-qa-semantic.md` pathname and
a distinct sentence from older qualification runs. Native `file_fetch` preserves
prior bytes through its media snapshot. Cleanup checks the fixture hash before
restoring those bytes; a newly created path becomes one empty reusable QA file.
It restores through the owned live binding before intentionally stopping it;
failed setup without a live node defers restoration until original startup.
Reruns do not accumulate same-content files. Observed concurrent edits are preserved.

Before model turns, the scenario connects to the real contained Codex server
using the existing supervisor probe identity. It verifies nonzero exit status,
8 MiB streaming output with an exact hash, stdin/EOF, explicit cancellation,
connection-loss process cleanup and fresh authenticated reconnect. No model
request is needed by those protocol checks; native deployment still performs its
ordinary model-authentication probe. Standalone `command/exec` receives the same
execution policy as normal Gateway turns, verified from effective configuration.
Pod identities and restart counts must stay unchanged.
The transport regression suite separately exercises actual TCP sockets and
bounded IPC streams: a slow downstream closes only its channel; temporary
shared-pipe pressure pauses the source without truncation; malformed framing
fails the shared transport closed. Neither suite changes sandbox permissions.

## Prepare and package the Box comparison

Use `deploy/runtime/strands-box/build.ts` from a clean OCE checkout. It accepts
an existing local Box Git repository containing these commits; it never fetches:

| Input            | Commit                                     |
| ---------------- | ------------------------------------------ |
| Refresh base     | `1ad7e987af6db807d66d896600c76a7d8d100b32` |
| Container change | `05efc455d65dfea67734f5cb71ca27b0ff5e9582` |
| Stdin change     | `aa1b8e419cf0deaad25113ab68d45451fef05450` |

Preparation checks merge base `069c39cfd29f830aaadd2a1af362753a57c7b202`,
composes the changes and materializes candidate tree
`57c4375a447f16f7b281cf0f4c590c351965af3a` in a new directory. Local source
preparation works on x86; native compilation requires Linux ARM64 GNU and the
already-installed Rust 1.98.1 toolchain. Cargo uses locked dependencies and an
explicit target. The build verifies the output ELF architecture. Do not use
emulation to claim native qualification.

From the OCE repository root, set `BOX_GIT` to that local repository and
`OCE_RUNTIME_IMAGE` to the immutable `repository@sha256:digest` of the matching
local ARM64 runtime. Keep OpenClaw
`f8386bc7df0a6c9eda7a28ae81943c5c06a414ff` and the patches in
`deploy/runtime/Dockerfile`. The build checks the base image's platform and
OpenClaw label. The operator must select the base produced by this recipe,
including its reviewed patch set. The optional local-memory layer is permitted.

```sh
node deploy/runtime/strands-box/build.ts prepare \
  --source "$BOX_GIT" --out .build/box-candidate
node deploy/runtime/strands-box/build.ts build \
  --out .build/box-candidate --runtime-image "$OCE_RUNTIME_IMAGE"
node deploy/runtime/strands-box/build.ts package \
  --artifacts .build/box-candidate/artifacts --out .build/box-image
```

Use fresh output directories. A failed operation retains its directory for
inspection; select a new directory for a retry. `build` creates artifacts only
after verifying the source and host. `package` verifies artifact hashes before
invoking Docker Buildx, then writes a single-platform OCI `image.tar` without
publishing. Docker also verifies installed hashes, architecture and modes as
`node`: binaries are `0555`, bridges are `0444`. Buildx must have access to the
selected base image. No command provisions a cluster or installs a toolchain.

The artifacts' `build-record.json` records input commits, composed tree, actual
Rust version and target, OCE revision, base image digest and every binary/bridge
hash. Inspect the same record at `/opt/strands-box/build-record.json` in the image.
`image-record.json` records the image manifest/config digests, archive hash and
build-record hash outside the image. Image receipts establish identity only; matching
labels do not prove that an image contains the payload. Zero-layer images are
refused. Later layers can overwrite earlier files, so installed QA must verify
the actual final files before accepting the image. These records describe the controlled build;
they are not cryptographic attestations or a claim of deterministic binaries.
The supported source-to-artifact guarantee requires the `build` command. Direct
Dockerfile use verifies the supplied record and bytes but cannot establish who
produced them.

Apply the [code-mode layer](../guides/deploy/strands-code-mode.md) last, preserving
the existing layers and labels, and export its result as a single-platform OCI
archive. Record that final archive before selecting the image for both runtime roles:

```sh
node deploy/runtime/strands-box/build.ts record-image \
  --artifacts .build/box-candidate/artifacts \
  --archive "$FINAL_OCI_ARCHIVE" --out .build/box-final-receipt
```

After separately authorized publication, verify the registry's manifest digest
against this receipt. If publication changes the digest, investigate and capture
the actual final manifest; do not substitute a local image/config ID. Publication
is outside this entrypoint. Hand the QA owner the final immutable reference,
build record and hash, final manifest, OCE revision, unchanged OpenClaw revision,
and the node setup seccomp profile and its hash.

For the historical comparison, prepare a separate directory with
`--variant baseline`; its expected tree is
`7cafba29bdc8cb7db1b2db9512bb2a4bd0c15d20`. The reported 37-check ARM64 run is
historical evidence, not qualification of either new build. Newer Box main
`3724c130` and an OpenClaw refresh are separate follow-ups.

Exercise the actual mismatch path with a new output directory; this must fail
before Cargo runs:

```sh
node deploy/runtime/strands-box/build.ts prepare \
  --source "$BOX_GIT" --out .build/box-wrong \
  --expected-tree 0000000000000000000000000000000000000000
```

After compilation, copy the artifacts to a disposable directory, change one
bridge file, and run `package` on that copy. It must report a SHA-256 mismatch
before Docker runs. Missing files, symbolic links and non-ARM64 executables also
fail. Run the independent source checks with:

```sh
node --test tests/conformance/strands-box-build.test.ts \
  tests/conformance/strands-box-transport.test.mjs
```

Install the reviewed Localhost setup seccomp profile through the node
administrator's normal provisioning path before deploying; never substitute an
unconfined profile or privileged installer Pod. The acceptance login scope is
`api_key`; PAT and Credential Proxy are excluded.

Generate the setup profile with
`scripts/generate-strands-box-seccomp.mjs <RuntimeDefault.json> <new-profile.json>`.
The baseline must be the operator-captured RuntimeDefault profile, not an
already-expanded Codex profile. The local ARM64 candidate preserves that
baseline and adds 12 exact setup rules for the original Box remount arguments.
It does not copy inherited mount flags into each remount. Other mount variants
require qualification. The workload filter still
rejects mount creation, `recvmsg`, and `kill(0)`. Qualify the generated profile
with the exact candidate before installation promotion.

The embedding phase explicitly calls the Memory Core `memory.index` Gateway
method after each provider switch. This requires `operator.admin` and uses the
Gateway's registered remote workspace access. A separate `operator.read` call
must be denied before maintenance; no index rows are injected and the standalone
local-only memory CLI is not used. The runtime patch has its own source hash in
runtime provenance. Cleanup restores both the original Configuration binding
and its matching derived index before stopping the retained Agent.

Final cleanup stops the retained Agent and replaces the model Secret with an
invalid synthetic value; it retains the cluster, Agent and original PVCs for reuse.

Set `OCC_TEST_QA_STRANDS_FIXTURE` to a private JSON file with these fields. Replace
all placeholders with the prepared environment's exact identities and image.
The API must be a loopback forward. The API-key and model-key files must be
owner-only regular files. Use only an authorized key; never put key values in
this fixture, source, command arguments, or evidence.

```json
{
  "allowAgentLifecycleMutation": true,
  "apiBaseUrl": "http://127.0.0.1:56765",
  "apiKeyFile": "/private/test-api-key",
  "kubeconfig": "/private/test-kubeconfig",
  "namespaceId": "ns_<uuid>",
  "namespaceName": "<owned-kubernetes-namespace>",
  "agentId": "agt_<uuid>",
  "modelSecretId": "sec_<uuid>",
  "model": "<authorized-api-model>",
  "runtimeImage": "<runtime-image>@sha256:<digest>",
  "runtimeBuildRecordFile": "/private/reviewed-build-record.json"
}
```

```sh
OCC_TEST_QA_MATRIX=1 OCC_TEST_QA_INSTALLATION=kubernetes \
OCC_TEST_QA_PRESET=Codex OCC_TEST_QA_SCENARIOS=strands-sandbox \
OCC_TEST_QA_STRANDS_FIXTURE="$STRANDS_FIXTURE" \
OCC_TEST_QA_OPENAI_KEY_FILE="$MODEL_KEY_FILE" \
OCC_TEST_QA_ARTIFACTS="$EVIDENCE_DIRECTORY" \
node --test tests/integration/qa-matrix-real.test.mjs
```

`runtimeBuildRecordFile` is mandatory: supply the reviewed build record from the
build host, not a record copied out of the selected image. QA sends the official
file-verification code and expected hashes from this checkout into each running
container. It requires the normal `node` user (UID 1000), then checks the actual
binaries, bridges and build record for hashes, file types, modes and access.
This also runs after replacement and for the second Agent. A replaced bundled
verifier or an in-image record cannot override the host expectations. Missing
files, later-layer overwrites, wrong users and Pod identity changes fail QA.

QA requires a nonempty image ID for every observed running container and checks
it against the selected image. No additional image-document fields are needed
when the selected digest is the running manifest digest. For an image index, add
`runtimeImageIndexFile` and `runtimeImageManifestFile` to the fixture, pointing
to the exact raw OCI index and its Linux ARM64 manifest. QA hashes both documents
and resolves the index's unique ARM64 descriptor. For runtimes reporting a config
digest, supply `runtimeImageManifestFile` even with a single-manifest reference.
QA accepts only the verified manifest or its config digest and records the mapping.
Missing identities, digest mismatches and stopped containers fail acceptance.

Require zero failures and zero skips, plus all checks passed in
`strands-sandbox.json`. An assistant's reply alone cannot pass the tool assertion.
The run uses eight model turns, local embedding inference and runtime startup
probes; evidence includes reported token usage, not a billing estimate. If the test
process is killed before
cleanup, stop that exact Agent and withdraw its model Secret through the normal
API before reusing the fixture.
