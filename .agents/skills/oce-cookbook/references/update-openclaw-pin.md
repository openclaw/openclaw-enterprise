# Update the pinned OpenClaw source

Use the upstream commit or tag selected in the request. If the target is missing
or ambiguous, ask for it before editing the pin; do not silently select the latest
release or main. Follow $local-dev for the change and $enterprise-testing for
qualification. Run repository commands from the OCE checkout root.

Edit [the source manifest](../../../../deploy/runtime/openclaw-source.json) to select
a new upstream commit. The commit identifies the source; an OpenClaw package
version or release tag alone does not. The [runtime recipe](../../../../deploy/runtime/README.md)
owns the build contract and its other dependency pins.

## 1. Select a reviewed commit

You need Bash, Git, curl, Node.js 24 or newer, and an OpenClaw checkout containing
the reviewed target commit. Verify that checkout's remote is the intended
`openclaw/openclaw` repository. Review the upstream changes from the currently
pinned commit before selecting a release tag or commit.

Run commands from the OCE repository root. Inspect the current selection:

```sh
node ./scripts/lib/openclaw-source.mjs build-args
```

The command prints the three validated Docker build arguments. Do not copy their
current values into Dockerfile defaults, test assertions, or another version file.

## 2. Record the new source identity

Replace the checkout path and reviewed ref below. Run the block in Bash. Resolve
the ref to a full commit and download the same source archive used by the runtime
Dockerfile. Hash the downloaded archive, not a checkout directory or release ZIP.
The example uses the commit's committer timestamp, normalized to UTC, as the fixed
build timestamp.

```bash
(
set -euo pipefail
OPENCLAW_CHECKOUT='/absolute/path/to/openclaw'
OPENCLAW_REF='REPLACE_WITH_REVIEWED_TAG_OR_COMMIT'
OPENCLAW_COMMIT="$(git -C "$OPENCLAW_CHECKOUT" rev-parse --verify "${OPENCLAW_REF}^{commit}")"
OPENCLAW_COMMIT_TIME="$(git -C "$OPENCLAW_CHECKOUT" show -s --format=%cI "$OPENCLAW_COMMIT")"
pin_dir="$(mktemp -d)"
trap 'rm -f -- "${pin_dir}/openclaw-source.tar.gz"; rmdir -- "${pin_dir}"' EXIT

curl --fail --location --show-error \
  "https://codeload.github.com/openclaw/openclaw/tar.gz/$OPENCLAW_COMMIT" \
  --output "${pin_dir}/openclaw-source.tar.gz"
tar -tzf "${pin_dir}/openclaw-source.tar.gz" > /dev/null

node --input-type=module - "$OPENCLAW_COMMIT" "$OPENCLAW_COMMIT_TIME" \
  "${pin_dir}/openclaw-source.tar.gz" <<'NODE'
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [commit, commitTime, archive] = process.argv.slice(2);
const pin = {
  commit,
  sourceArchiveSha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
  buildTimestamp: new Date(commitTime).toISOString().replace(".000Z", "Z"),
};
writeFileSync("deploy/runtime/openclaw-source.json", `${JSON.stringify(pin, null, 2)}\n`);
NODE

node ./scripts/lib/openclaw-source.mjs build-args
git diff -- deploy/runtime/openclaw-source.json
)
```

The manifest must contain the full lowercase 40-character commit, the archive's
64-character SHA-256, and a UTC timestamp in `YYYY-MM-DDTHH:mm:ssZ` form. Stop if
resolution, download, archive inspection, or validation fails. Correct the selected
inputs before rebuilding; do not bypass the archive checksum or restore an ARG
default to hide a mismatch. The subshell removes its temporary download on success
or failure through the EXIT trap. Any manifest edit remains in the checkout for
review or correction.

## 3. Check source-dependent assets and behavior

Review these consumers with the upstream diff:

- **Bridge patches and native dependencies:** check
  [`deploy/runtime/Dockerfile`](../../../../deploy/runtime/Dockerfile) against the new
  source and lockfile. Rebase necessary patches, or remove a bridge only after
  confirming the upstream fix. Keep patch checksums and the `appliedPatches`
  inventory in [runtime packaging](../../../../scripts/build-runtime-assets.mjs) together.
  Follow the runtime recipe for Codex and architecture-specific Matrix crypto pins;
  change them only when the selected source requires it.
- **Workspace defaults:** compare upstream templates with
  [`workspace-defaults.mjs`](../../../../packages/contracts/src/workspace-defaults.mjs).
  Update rendered content, version, content identity, and source provenance when
  those inputs change. The file documents its content-hash format. Keep unchanged
  historical provenance accurate rather than replacing every old commit citation.
- **Runtime support:** review source-dependent configuration and compatibility
  assumptions, including [native worker support](../../../../docs/reference/harness-execution.md#native-worker-support).
  Schema acceptance alone does not qualify placement, enrollment, workspace access,
  containment, or model execution. Follow the owning qualification procedures and
  keep support flags consistent with the evidence.

Update affected current references, guides, and flows when behavior changes.
Preserve historical specifications and citations. Do not lower version or sandbox
gates to make an incompatible source pass.

## 4. Build and qualify the candidate

[Resolve build arguments from the manifest](../../../../deploy/runtime/README.md#resolve-openclaw-build-arguments)
and [build the runtime](../../../../deploy/runtime/README.md#build-a-local-runtime-image).
CI and development launchers resolve the manifest automatically. A direct Docker
build needs the explicit arguments. Conflicting build arguments fail before the
archive download.

Use [local checks](../../../../docs/testing/local.md) for changed code and documentation, then
exercise the affected behavior with the [integration guides](../../../../docs/testing/README.md).
Workspace changes need the existing template-parity coverage against the built
runtime. Native worker qualification needs the relevant
[real-runtime procedures](../../../../docs/testing/kubernetes.md#kubernetes-model-turns-and-secrets),
with their required infrastructure and authorized credentials.

Push the candidate and record its full OCE commit SHA. Follow
[Check native images without publication](../../../../docs/release/containers.md#check-native-images-without-publication)
to dispatch `container-check.yml` on that exact ref with `source_sha` set to the
reviewed OCE SHA. This is the OCE PR commit, not the upstream OpenClaw commit.

Before merge, require successful controller and runtime builds and startup checks
on native AMD64 and ARM64. Include the run URL, final PR head SHA, all four outcomes,
and relevant version/probe results in the PR. Missing, failed, cancelled, or skipped
required checks block merging. Recheck the final head after further commits;
ordinary PR CI or a local single-architecture build is insufficient.

## 5. Hand off publication

Merging the pin does not update published images. If publication is authorized,
follow [Prepare and publish](../../../../docs/release/containers.md#prepare-and-publish) using the
merged main commit and its successful main-push CI run. Record the publication
owner when handing off the PR. Verify the image receipt and both remote image
identities before announcing updated images; use
[published-image verification](../../../../docs/guides/deploy/published-images.md) before deployment.

Report the selected upstream commit, the OCE head, changed supporting assets,
validation results, and whether publication is complete or still pending.
