# ARM64 Codex Harness for sandboxes that forbid JIT

Strands Box can start the stock Codex 0.164.0 Code Mode host and open a
session, but JavaScript evaluation can terminate the host before it returns a
result. The optional Harness image runs the same Codex CLI and V8 sandbox with
the interpreter enabled. Supply the OCE runtime image already selected for
your installation, pinned by its manifest digest.

```bash
docker buildx build --platform linux/arm64 --load \
  --build-arg OCE_RUNTIME_IMAGE="$OCE_RUNTIME_IMAGE" \
  -t oce-codex-harness:interpreter deploy/runtime/code-mode
```

The recipe checks the Codex source archive, V8 archive and bindings, normalized
Cargo lock and installed Codex package version. It installs the host in the
package's `codex-resources` directory, where Codex looks first. The build
requires that host to evaluate `19 + 23` and return `42` without network
access. Select the resulting image for the sandboxed dedicated Harness and
verify a Code Mode result through the installed Agent.
