# Run native code mode inside Strands Box

Build the optional OCE code-mode entrypoint with the matching Codex libraries.
It calls the public `initialize_v8(V8JitMode::Disabled)` API, then the native
`codex_code_mode_host::run_main`. Box continues to prohibit generating executable
memory (W^X). Codex libraries, protocol, app-server and sandbox policy are unchanged.
The host stays inside the revision Pod's contained workload.

The bundled Codex version is `0.163.0-alpha.2`. Its default host completes the
protocol handshake inside Box but exits with `SIGTRAP` on the first JavaScript
cell. The OCE entrypoint selects the interpreter before any isolate starts.
Node's separate `--jitless` option does not configure the Rust V8 runtime.

## Build and package

Prepare a staging copy of Codex commit
`a6274249d5877030676db098914db686bab7c921`, the source behind
`rust-v0.163.0-alpha.2`. Build for the image's architecture and libc. The local
qualification uses Rust 1.95.0, Debian Bookworm, ARM64 GNU and Cargo's release
profile. Do not apply a Codex source patch.

Use that source's `scripts/codex_package/v8.py` to obtain its official,
checksum-verified Rusty V8 artifacts with pointer compression and the V8 sandbox
enabled. Set `RUSTY_V8_ARCHIVE` and `RUSTY_V8_SRC_BINDING_PATH` to those artifacts.
The release source's workspace version is `0.163.0-alpha.2`, while its lockfile
records local packages as `0.0.0`. Normalize only those workspace versions;
verify that external package identities and checksums remain identical.

From the OCE checkout, in that Linux build environment:

```sh
sh deploy/runtime/code-mode/build.sh "$CODEX_STAGING_SOURCE" "$CODE_MODE_ARTIFACTS"
```

The script adds only OCE's entrypoint as
`code-mode-host/src/bin/oce-code-mode-host.rs`. Cargo discovers this binary and
builds it with the pinned workspace dependencies and `--locked`; no upstream
manifest, library or native entrypoint is replaced. Keep the staging tree for
provenance. The artifact directory contains the stripped packaging binary and
an unstripped copy for diagnostics. Record both hashes.

Copy this checkout's `deploy/runtime/strands-box/proxy-preload.mjs` into the
artifact directory. Package the binary onto the matching runtime:

```sh
docker buildx build --load --platform linux/arm64 \
  -f deploy/runtime/code-mode/Dockerfile \
  --build-arg OCE_RUNTIME_IMAGE="$OCE_RUNTIME_IMAGE" \
  -t oce-runtime:strands-code-mode "$CODE_MODE_ARTIFACTS"
```

The recipe replaces the installed code-mode host at the pathname already used
by native app-server discovery. The package layout names `linux-musl`, but the
qualified image is Debian and this binary uses GNU libc. No executable path or
remote host is injected into model requests. Record source, entrypoint, binary
and final image hashes. Select the immutable image through normal Installation
configuration. This recipe does not update published runtime pins.

## Supported entrypoint behavior

The OCE entrypoint supports the native default transport and `--listen URL`.
It sends logs to stderr, leaving protocol stdout intact. Unknown arguments fail.
It does not expose the upstream executable's two optional OTEL listener/exporter
flags, which the selected OCE app-server launch path does not pass. It is an
OCE-owned executable using Codex libraries, not the stock Codex host executable.
Recheck CLI and library compatibility before changing the bundled Codex source.

Interpreter selection is unconditional in this optional image. There is no
fallback to JIT and no environment variable that turns the restriction off.
Native code-mode tools remain enabled. The provider preload still handles
Node routing and Node's separate `--jitless` setting; it does not choose V8 mode.

## Verify the installed runtime

Run a credential-free framed-protocol execution inside the exact Restricted
Box Pod. A cell must return its computed value, with `process` and `require`
unavailable, and close its session cleanly. Compare the default upstream host
under identical seccomp and mount policies to establish the cause.

Then run native OCE QA with a real model code-mode call on the same immutable
image, including split storage, files, skills, keyword and local semantic memory,
and lifecycle checks. Stop/start the VM and verify automatic recovery on that
image. An earlier patched-host image's result does not qualify this replacement.
Keep failed results; do not disable code mode or loosen Box policy for acceptance.
