# ARM64 Codex Harness for sandboxes that forbid JIT

A Sandbox that forbids JIT can start the stock Codex 0.164.0 Code Mode host
and open a session, but JavaScript evaluation can terminate the host before it
returns a result. The optional Harness image runs the same Codex CLI and V8 sandbox with
the interpreter enabled. Supply the OCE runtime image already selected for
your installation, pinned by its manifest digest.

Run the build from the root of the OCE checkout that built that runtime image,
on a native ARM64 builder:

```bash
docker buildx build --platform linux/arm64 --load \
  --build-arg OCE_RUNTIME_IMAGE="$OCE_RUNTIME_IMAGE" \
  -f deploy/runtime/code-mode/Dockerfile \
  -t oce-codex-harness:interpreter .
```

The recipe checks the Codex source archive, V8 archive and bindings, normalized
Cargo lock and installed Codex package version. It installs the host in the
package's `codex-resources` directory, where Codex looks first. It then
rebuilds `/opt/oce/runtime/contents.json` and its provenance digest with the
[runtime inventory](../README.md#build-a-local-runtime-image), and records the
host's source commit, JIT mode and SHA-256 as `codeModeHost` in
`provenance.json`.

The last step runs without network access. Both the stock host and the
packaged host must evaluate `19 + 23` and return `42`. The stock host must
also map executable memory that no file backs, which is its V8 JIT code
range. The packaged host must map none. A host that maps JIT memory fails in a
sandbox that forbids JIT. User-mode emulation maps its own translated code, so
the step refuses to run under it.

Select the resulting image for the sandboxed dedicated Harness and verify a
Code Mode result through the installed Agent.
