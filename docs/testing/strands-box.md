# Rehearse Strands repository withdrawal locally

Use the `strands-sender` lane to check the real Strands repository sender with
native Codex, real Git, mutual TLS, and controlled local services. It uses the
shared [Agent grant rehearsal](../../tests/helpers/agent-grant-rehearsal.ts).
It does not start Box or an installed OpenClaw Enterprise (OCE) deployment.

## Run the rehearsal

Use Linux as a nonroot user, Node and dependencies from the
[testing requirements](README.md#requirements-and-credentials), Git, OpenSSL,
and the native Codex version pinned in the [runtime image](../../deploy/runtime/Dockerfile).
Set `OCC_TEST_STANDING_GIT_CODEX` to that executable's absolute path. The test
does not download binaries, use account credentials, or call public providers.

From the repository root:

```sh
OCC_TEST_STRANDS_SENDER_REHEARSAL=1 \
  node --test tests/integration/strands-sender-rehearsal.test.ts
```

For the existing runner's result accounting, choose fresh result paths:

```sh
node scripts/ci/run-tests.mjs run strands-sender \
  --state "$RUN/state.json" --results "$RUN/results.json"
```

The lane sets the selector and requires the executable input. Without the
selector, the ordinary test sweep skips this case. Once selected, missing
inputs and runtime failures fail the case. No PostgreSQL or Kubernetes setup
is required.

Require one passing case, zero skips, and all four check records:

1. `model-before`: the native process finishes a model turn and persists the reply.
2. `git-fetched`: a fresh commit arrives through the real sender and matches the
   independently read origin SHA.
3. `git-refused`: after the controlled authority withdraws Git access, Git exits
   128, the sender records `material-refused` with reason `withdrawn`, the new
   commit stays absent, and no new provider connection or request occurs.
4. `model-after`: a new turn finishes on the same process and session. Its
   request includes the first reply, and the second reply is read back.

Each attempt owns temporary repositories, certificates, loopback listeners and
a native process. Teardown stops and joins the native process before removing
its files and closing the model origin. Keep selected runs separate from broad
integration sweeps.

## Interpret the result

The sender, Git protocol, TLS authentication, native process and conversation
are exercised directly. The recipient observation, material authority, GitHub
origin and model responses are fixtures. Agent and revision IDs label this
local fixture; they are not records created through OCC.

This catches sender regressions that permit a fresh fetch after withdrawal or
break conversation continuity. It does not prove Box containment, Box policy
reload, Worker reconciliation, production credential custody, Gateway chat,
or an installed model turn. The existing
[deployment test](../../tests/integration/strands-box-deployment.test.ts)
separately checks the Worker and installed Driver's held admission with
PostgreSQL and controlled Kubernetes and host peers.

To extend the rehearsal to a Box runtime, follow
[the runtime adapter contract](protected-repository-custody.md#reuse-the-rehearsal-with-another-runtime).
Replace the fixture recipient and material authority with observations and
withdrawal through the selected integration. Keep the model and Git origins
outside Box, provide trusted fixture TLS through a supported host input, and
observe policy denial in the actual Box journal. A host that cannot create
Box's namespaces cannot qualify containment with this lane.

## Diagnose a failure

Missing executable or execution permission fails before startup. A native RPC
deadline reports bounded protocol event names and stderr; do not replay an
uncertain turn. A model-origin rejection identifies a fixture contract failure.
If withdrawal fails, inspect the sender's terminal receipt, provider counters,
and object lookup before changing production behavior. Run the focused sender
controls with `node --test tests/conformance/strands-box-git.test.ts`.
