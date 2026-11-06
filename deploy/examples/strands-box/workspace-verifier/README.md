# Read one synthetic marker through Box Shell Calls

This optional Linux ARM64 fixture lets a Codex tool call read one pre-staged
synthetic marker through stock Box v0.2.1. It grants neither a general shell
command nor additional native execution access to the agent. Leave the option
unset in ordinary deployments.

Build the static verifier from this checkout with the repository's Go version:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -buildvcs=false \
  -ldflags='-s -w -buildid=' -o /absolute/staging/oce-workspace-verifier \
  ./deploy/examples/strands-box/workspace-verifier
sha256sum /absolute/staging/oce-workspace-verifier
```

On the dedicated Box host, have the trusted host installer stage those verified
bytes at `/opt/demo/verifier/oce-workspace-verifier`. The executable and its
ancestors must be root-owned, canonical paths with no group or world write
permission. In the selected private workspace, stage a regular file named
`.oce-model-marker` containing exactly 48 lowercase hex characters and a final
newline. Use fresh synthetic bytes; do not put a credential in that file.

In the mode-`0600` Box host configuration, set `workspaceVerifierSha256` to
the compiled executable's exact SHA-256. Do not add the program or its
directory to the agent's filesystem or execution grants. The launcher checks
the installed file, adds a single [Box Shell Calls spawn rule][shell], and
uses a separate [declared tool][tool] with a read grant for only the marker.
The existing egress gateway remains in force. The verifier itself does not
use the network, run another program, or write to the workspace.

From the admitted Agent, invoke the literal command below through its normal
shell tool, with no arguments, in the selected workspace:

```text
/opt/demo/verifier/oce-workspace-verifier
```

Expect `OCE_BOX_MARKER_IDENTITY <uid> <dev> <ino>` and
`OCE_BOX_MODEL_MARKER <marker>`. Compare the marker and file identity with
independent host readback. Compare the file inode, not the directory inode:
the separate tool sees a file projection rather than the agent's workspace
directory mount. An added argument, a builtin such as `printf`, and a nested
shell are still refused by the Box broker.

To run the independent stock Box integration case on a supported nonroot
Linux ARM64 host, stage the verified helper as above and point the test at the
v0.2.1 release executable with its two original helpers beside it:

```sh
OCC_TEST_STRANDS_BOX_SHELL_BOX=/absolute/verified-box/box \
OCC_TEST_STRANDS_BOX_SHELL_VERIFIER_SHA256="$VERIFIER_SHA256" \
  node --test --test-name-pattern 'stock Box Shell Calls admit' \
  tests/conformance/strands-box-host.test.ts
```

The test starts a fresh credential-free Box with a temporary marker and no
permitted network destinations. It checks one successful Shell Calls receipt,
the extra-argument, builtin, and nested-shell denials, and that the marker is
unchanged. This direct Box test is separate from qualification of an installed
Agent and Gateway chat.

[shell]: https://github.com/strands-agents/box/blob/e39544d49188b82933264b83159c7ccc278ced5a/docs/user/shell.md#shellspawn
[tool]: https://github.com/strands-agents/box/blob/e39544d49188b82933264b83159c7ccc278ced5a/docs/user/shell.md#toolname
