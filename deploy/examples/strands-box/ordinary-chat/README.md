# Reproduce one ordinary Gateway chat through Box

Run one normal OpenClaw terminal chat against native Codex in stock Strands Box
v0.2.1 on a dedicated Linux ARM64 placement. The model is a deterministic
Responses fixture on loopback inside the same Box network namespace as Codex.
It asks the normal Codex shell tool to try a forbidden argument and then read
one synthetic workspace file using the
[declared Box tool](../workspace-verifier/README.md). There are no model API
keys, repository credentials, Git operations, or production provider calls.

## Build and prepare

From this checkout, use the [normal runtime image recipe](../../../runtime/README.md#build-a-local-runtime-image)
with the resolved upstream build arguments, `--platform linux/arm64`, and
`--build-arg OCC_BUILD_REVISION=$(git rev-parse HEAD)`. Use an image built from
this source, including the owner-bound runtime patch, not a prior image with
the same upstream version string. Verify the ARM64 image's manifest/config,
upstream and OCE revisions, and packaged provenance before starting Gateway.
Use the same pinned Node 24 and native Codex 0.164.0 on the Box host.

Follow the [public Box smoke setup](../README.md#prepare-the-host-and-verify-box)
for the exact released ARM64 suite, canonical native executable paths, the
owner-only smoke config, and the normal read/exec prerequisites. For this repro:

- Give the nonroot operator a fresh private `/home/node/workspace` and a fresh
  empty Box `runtimeDir`. Keep the operator home and state outside the grants.
- Build and install the fixed workspace verifier as directed in the
  [tool guide](../workspace-verifier/README.md). Pin its installed digest in
  `workspaceVerifierSha256`; do not add it to the agent's read or exec lists.
- Keep Box's normal contained networking and leave external egress ungranted.
  The local model fixture does not require a Box egress route.

Set `OCE` to the canonical absolute checkout; `CONFIG` to the private smoke
config; `RUN` to a fresh, empty mode-0700 operator receipt directory; and
`AGENT_BUILD_DIR` to the config's separate agent module directory. Set
`FIXTURE_BUILD_DIR` to another fresh private directory outside the workspace
and runtime. Run with the repository's frozen dependencies:

```sh
umask 077
cd "$OCE"
REPRO="$OCE/deploy/examples/strands-box/ordinary-chat"
pnpm exec tsc -p deploy/examples/strands-box/host/tsconfig.agent.json --outDir "$AGENT_BUILD_DIR"
pnpm exec tsc -p deploy/examples/strands-box/ordinary-chat/tsconfig.fixture.json --outDir "$FIXTURE_BUILD_DIR"
node "$REPRO/operator.ts" seed "$RUN"
node "$REPRO/launch-fixture.ts" "$CONFIG" "$FIXTURE_BUILD_DIR/box-workload.js" "$RUN"
```

The wrapper uses the public Box launcher and its generated one-tool policy.
It starts the unmodified native app-server with the original capability
verifier, records the loopback peer's network-namespace match, and leaves the
original Box owner and listener in place. Wait for `BOX_REPRO_NATIVE_READY`.
The fresh Codex home is the `codex` directory in the runtime's `-home` sibling.

## Connect Gateway to the original owner

Start the same source revision's [private host ingress](../ingress/README.md)
against the original `ready.json` digest. Use an approved private IPv4 listener
and a certificate with the exact private DNS authority as its SAN. For this
standalone repro the trusted Gateway reaches that ingress directly over the
private route; no Kubernetes Service or relay Pod is required.

### Bind a standalone Gateway to one Box execution

Before enabling the binding, verify the dedicated placement and confirm that
the original live Box confines the admitted workspace and denies all egress
outside its admitted policy. A receipt hash identifies that execution. The
operator and supervisor own this check.

Run the Gateway as a nonroot user. Mount a root-owned mode-0555 directory
read-only at `/etc/openclaw-box-owner` in the Gateway. Its ancestors must be
root-owned and neither group- nor world-writable. Use root-owned mode-0444
regular files with one link each and no symlinks. Its `ca.pem` contains the
ingress CA. Its compact JSON `binding.json` contains only the canonical
`wss://HOST[:port]/` URL, the workspace root `/home/node/workspace`, and the
SHA-256 of the original owner's exact `ready.json` bytes, under the keys `url`,
`workspaceRoot`, and `generationSha256`. Set the trusted runtime inputs
`APP_SERVER_URL` and `APP_SERVER_TOKEN` to that same URL and the native
transport bearer. Configure the dedicated Harness app-server as a WebSocket
with the same endpoint, workspace, and bearer, with no additional headers.
The bearer is the
launcher's native transport capability, not the Gateway login token. Keep it
in the Gateway's normal secret inputs. Do not print it or put it in the run
directory. Leave device pairing, TLS verification, and native authentication
enabled.

An absent directory leaves ordinary Gateway behavior in place. A selected
directory with either missing or invalid file refuses the binding. The
runtime rechecks the mounted file identities and requires the exact generation
on the CA-verified upgrade before sending native frames. For an ordinary
workspace-write turn at the bound root, it selects external sandboxing with
restricted network access and no alternate execution environment. Explicit
read-only and workspace-restricted policies remain available inside that root.
The bound connection accepts the chat RPCs and refuses direct shell and exec RPCs.
Replacing the Box closes its original ingress. Set up a fresh binding before
connecting a new Gateway, and reconcile any uncertain earlier turn before
submitting another one.

Start a fresh ordinary local-mode Gateway on loopback port 18789 with the selected Codex runtime, no
model fallback, and an isolated state directory. Use its normal authenticated
local CLI/device context. The relevant config fragment is below; OpenClaw
resolves the environment references in the trusted Gateway process.

```json
{
  "gateway": { "mode": "local", "bind": "loopback" },
  "agents": {
    "entries": { "main": {} },
    "defaults": {
      "workspace": "/home/node/workspace",
      "model": { "primary": "codex/box_repro_fixture/gpt-5", "fallbacks": [] },
      "models": {
        "codex/box_repro_fixture/gpt-5": { "agentRuntime": { "id": "codex" } }
      }
    }
  },
  "models": {
    "providers": {
      "codex": {
        "baseUrl": "http://127.0.0.1:18949/v1",
        "api": "openai-responses",
        "models": [{ "id": "box_repro_fixture/gpt-5", "name": "Controlled gpt-5" }]
      }
    }
  },
  "plugins": {
    "entries": {
      "codex": {
        "enabled": true,
        "config": {
          "appServer": {
            "transport": "websocket",
            "url": "${APP_SERVER_URL}",
            "authToken": "${APP_SERVER_TOKEN}",
            "remoteWorkspaceRoot": "/home/node/workspace",
            "sandbox": "workspace-write"
          }
        }
      }
    }
  }
}
```

The explicit `agentRuntime.id` selects Codex. Keep the model reference
`codex/box_repro_fixture/gpt-5`: the `codex/` prefix lets the app-server use the
provider named in the qualified model, and `box_repro_fixture` matches the
provider configured by the launcher in the Box Codex home. The Gateway
entry describes that loopback fixture and needs no API key. An `openai/`
model reference selects a different provider.

Do not add a permission profile or custom headers. The guarded runtime checks
the CA-verified upgrade and exact generation before dispatching native frames.
It selects restricted external sandboxing only for the admitted workspace. If
the original owner exits or is replaced, retire the ingress and reconcile the
existing chat rather than retrying it.

## Send and verify one chat

On the dedicated operator placement, set `GATEWAY_CLI` to the canonical stock
OpenClaw executable for the built runtime (use `realpath -e /app/openclaw.mjs`
in the normal runtime layout). Use an isolated local CLI configuration with the normal Gateway auth and
approved device, separate from the Gateway's native app-server configuration.
The operator caller strips the native app-server URL and capability from the
stock CLI environment. The independent owner check needs those inputs and
read access to the trusted binding.

```sh
umask 077
node "$REPRO/owner-check.ts" > "$RUN/owner-wss.json"
node "$REPRO/operator.ts" submit "$RUN" "$GATEWAY_CLI"
```

The wrapper saves one intent and runs stock `openclaw gateway call chat.send`
at the pinned local Gateway origin. This is the same chat method the TUI uses,
with a fresh session, a unique run ID, and a fresh synthetic nonce shared with
the local fixture. The admission response is not a finished reply. Wait for
the controlled model and Box receipts; after intent use the read-only
verification below to reconcile any uncertain outcome. Do not submit again.

Under the original nonroot owner, capture only the receipts from this run.
`RUNTIME_DIR` is the smoke config's exact `runtimeDir`.

```sh
CODEX_HOME="$(dirname "$RUNTIME_DIR")/$(basename "$RUNTIME_DIR")-home/codex"
install -m 0600 "$CODEX_HOME/controlled-chat.jsonl" "$RUN/controlled-chat.jsonl"
install -m 0600 "$RUNTIME_DIR/box-state/state/private/telemetry/records.jsonl" "$RUN/box-records.jsonl"
node "$REPRO/operator.ts" verify "$RUN" "$GATEWAY_CLI"
```

Verification joins the original read-only marker digest and inode, the actual
tool result, one exact named stock Box permit and one denied alternate, and
the nonce-matched user prompt and terminal assistant reply from Gateway
`chat.history`. It requires a successful `agent.wait` result for the exact
run ID. Keep the
receipts private. Stop Gateway, ingress and the original Box after collecting
them. This repro does not test an installed Controller or Worker, a
workspace-node connection, an external provider, or a protected Git operation.
An outside-sibling refusal requires its own separate control.

Run the local fixture and negative controls with
`node --test tests/conformance/strands-box-ordinary-chat.test.ts`. Those tests
exercise the actual loopback Responses handler and receipt checks, not an ARM
Box or Gateway run.
